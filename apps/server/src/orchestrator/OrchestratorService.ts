/**
 * OrchestratorService — server-side state for "is this thread an orchestrator
 * (master) that can spawn worker Claude instances?"
 *
 * Why this lives in the binding's runtimePayload (server-side) instead of the
 * composer draft store (client-side) like the other toolbar toggles
 * (model, runtime mode, interaction mode):
 *
 * The ClaudeAdapter reads `runtimePayload.orchestrator.isMaster` from the
 * ProviderSessionDirectory binding when it starts a session, to decide
 * whether to attach the in-process MCP server. The binding is the source
 * of truth the runtime actually consults.
 *
 * Putting the toggle in the composer draft store would mean shipping its
 * value through `thread.create`, having the decider/projector translate
 * that into a binding mutation, then having the adapter read the binding
 * anyway — three layers of indirection encoding the same fact. Keeping
 * the marker on the binding directly is the cleanest cut.
 *
 * Visible tradeoffs:
 *   - No "sticky" preference layer (every new thread starts un-promoted).
 *     This is intentional: orchestrator threads spawn workers with real
 *     side effects; opt-in per-thread is a feature, not a bug.
 *   - One-RPC round-trip when toggling. Negligible on localhost.
 *   - The binding can outlive an abandoned draft thread. Cleaned up by
 *     ThreadDeletionReactor when the thread is deleted.
 *
 * Workers are plain Claude threads — no role-based system prompts, no tool
 * restrictions. The master shapes worker behavior through the `task` text
 * passed to spawn_worker.
 */
import {
  type OrchestrationLatestTurn,
  type OrchestratorWorkerSummary,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import { Context, Data, Effect, Layer, Option } from "effect";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";

export class OrchestratorPromoteFailure extends Data.TaggedError(
  "OrchestratorPromoteFailure",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface OrchestratorBindingPayload {
  readonly orchestrator?: { readonly isMaster: boolean };
  readonly workerOf?: {
    readonly masterThreadId: string;
    readonly spawnedAt: string;
    readonly projectId?: string;
  };
  // `roleId` was on this shape until the role system was deleted. Old
  // bindings on disk may still carry it; we read but ignore it.
}

function readPayload(value: unknown): OrchestratorBindingPayload {
  if (!value || typeof value !== "object") return {};
  return value as OrchestratorBindingPayload;
}

/**
 * Derive worker status from the projection's latestTurn — NOT the binding's
 * `status` field. The binding's status tracks the SDK session lifecycle
 * (alive/dormant), which would falsely report a worker as "running" between
 * turns or after a turn completes while the SDK session is still warm.
 *
 * latestTurn.state is the per-turn signal the master actually wants:
 * is the worker currently processing, or is it done?
 */
function deriveStatusFromLatestTurn(
  latestTurn: OrchestrationLatestTurn | null,
): OrchestratorWorkerSummary["status"] {
  if (!latestTurn) return "idle";
  switch (latestTurn.state) {
    case "running":
      return "running";
    case "completed":
      return "idle";
    case "interrupted":
      return "stopped";
    case "error":
      return "errored";
    default:
      return "unknown";
  }
}

export interface OrchestratorServiceShape {
  readonly listWorkers: (input: {
    readonly masterThreadId?: string;
  }) => Effect.Effect<ReadonlyArray<OrchestratorWorkerSummary>, never>;
  readonly promote: (
    threadId: ThreadId,
  ) => Effect.Effect<{ threadId: ThreadId; isMaster: boolean }, OrchestratorPromoteFailure>;
  readonly demote: (
    threadId: ThreadId,
  ) => Effect.Effect<{ threadId: ThreadId; isMaster: boolean }, OrchestratorPromoteFailure>;
  readonly isMaster: (threadId: ThreadId) => Effect.Effect<boolean, never>;
}

export class OrchestratorService extends Context.Service<
  OrchestratorService,
  OrchestratorServiceShape
>()("t3/orchestrator/OrchestratorService") {}

const makeOrchestratorService = Effect.gen(function* () {
  const directory = yield* ProviderSessionDirectory;
  const projection = yield* ProjectionSnapshotQuery;

  const listWorkers: OrchestratorServiceShape["listWorkers"] = (input) =>
    Effect.gen(function* () {
      const bindings = yield* directory.listBindings().pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<never>),
      );
      const out: Array<OrchestratorWorkerSummary> = [];
      for (const binding of bindings) {
        const payload = readPayload(binding.runtimePayload);
        if (!payload.workerOf) continue;
        if (
          input.masterThreadId !== undefined &&
          payload.workerOf.masterThreadId !== input.masterThreadId
        ) {
          continue;
        }
        // Read latestTurn.state from the projection — this is the per-turn
        // signal that tells us whether the worker is actively processing.
        const shellOpt = yield* projection
          .getThreadShellById(binding.threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        const latestTurn = Option.isSome(shellOpt)
          ? shellOpt.value.latestTurn
          : null;
        const summary: OrchestratorWorkerSummary = {
          threadId: binding.threadId,
          masterThreadId: ThreadId.make(payload.workerOf.masterThreadId),
          projectId: ProjectId.make(payload.workerOf.projectId ?? "unknown"),
          spawnedAt: payload.workerOf.spawnedAt,
          status: deriveStatusFromLatestTurn(latestTurn),
        };
        out.push(summary);
      }
      return out as ReadonlyArray<OrchestratorWorkerSummary>;
    });

  const wrapPromoteFailure = (operation: string) =>
    Effect.mapError(
      (cause: unknown) =>
        new OrchestratorPromoteFailure({
          message: `Failed to ${operation} orchestrator binding.`,
          cause,
        }),
    );

  const promote: OrchestratorServiceShape["promote"] = (threadId) =>
    Effect.gen(function* () {
      const existingOpt = yield* directory.getBinding(threadId);
      if (existingOpt._tag === "None") {
        // Fresh binding: must include providerInstanceId so the runtime can
        // route to a configured Claude instance.
        const driverKind = ProviderDriverKind.make("claudeAgent");
        yield* directory.upsert({
          threadId,
          provider: driverKind,
          providerInstanceId: defaultInstanceIdForDriver(driverKind),
          adapterKey: "claudeAgent",
          status: "stopped",
          runtimePayload: { orchestrator: { isMaster: true } },
        });
        return { threadId, isMaster: true };
      }
      const existing = existingOpt.value;
      const payload = readPayload(existing.runtimePayload);
      yield* directory.upsert({
        threadId,
        provider: existing.provider,
        ...(existing.providerInstanceId
          ? { providerInstanceId: existing.providerInstanceId }
          : { providerInstanceId: defaultInstanceIdForDriver(existing.provider) }),
        ...(existing.adapterKey ? { adapterKey: existing.adapterKey } : {}),
        ...(existing.status ? { status: existing.status } : {}),
        runtimePayload: { ...payload, orchestrator: { isMaster: true } },
      });
      return { threadId, isMaster: true };
    }).pipe(wrapPromoteFailure("promote"));

  const demote: OrchestratorServiceShape["demote"] = (threadId) =>
    Effect.gen(function* () {
      const existingOpt = yield* directory.getBinding(threadId);
      if (existingOpt._tag === "None") return { threadId, isMaster: false };
      const existing = existingOpt.value;
      const payload = readPayload(existing.runtimePayload);
      const { orchestrator: _omit, ...rest } = payload;
      yield* directory.upsert({
        threadId,
        provider: existing.provider,
        ...(existing.providerInstanceId
          ? { providerInstanceId: existing.providerInstanceId }
          : { providerInstanceId: defaultInstanceIdForDriver(existing.provider) }),
        ...(existing.adapterKey ? { adapterKey: existing.adapterKey } : {}),
        ...(existing.status ? { status: existing.status } : {}),
        runtimePayload: rest,
      });
      return { threadId, isMaster: false };
    }).pipe(wrapPromoteFailure("demote"));

  const isMaster: OrchestratorServiceShape["isMaster"] = (threadId) =>
    Effect.gen(function* () {
      const bindingOpt = yield* directory.getBinding(threadId).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (!bindingOpt || bindingOpt._tag === "None") return false;
      const payload = readPayload(bindingOpt.value.runtimePayload);
      return payload.orchestrator?.isMaster === true;
    });

  return { listWorkers, promote, demote, isMaster } satisfies OrchestratorServiceShape;
});

export const OrchestratorServiceLive = Layer.effect(OrchestratorService, makeOrchestratorService);
