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
 */
import {
  type OrchestratorRole,
  type OrchestratorWorkerSummary,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Data, Effect, Layer } from "effect";

import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { OrchestratorRoles } from "./roles.ts";

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
    readonly roleId?: string;
    readonly spawnedAt: string;
    readonly projectId?: string;
  };
}

function readPayload(value: unknown): OrchestratorBindingPayload {
  if (!value || typeof value !== "object") return {};
  return value as OrchestratorBindingPayload;
}

function deriveStatus(
  status: string | undefined,
): OrchestratorWorkerSummary["status"] {
  if (status === "running" || status === "idle" || status === "stopped") return status;
  if (status === "errored") return "errored";
  return "unknown";
}

export interface OrchestratorServiceShape {
  readonly listRoles: () => Effect.Effect<ReadonlyArray<OrchestratorRole>, never>;
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
  const roles = yield* OrchestratorRoles;

  const listRoles: OrchestratorServiceShape["listRoles"] = () => roles.listRoles;

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
        const summary: OrchestratorWorkerSummary = {
          threadId: binding.threadId,
          masterThreadId: ThreadId.make(payload.workerOf.masterThreadId),
          projectId: ProjectId.make(payload.workerOf.projectId ?? "unknown"),
          ...(payload.workerOf.roleId ? { roleId: payload.workerOf.roleId } : {}),
          spawnedAt: payload.workerOf.spawnedAt,
          status: deriveStatus(binding.status),
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
        yield* directory.upsert({
          threadId,
          provider: ProviderDriverKind.make("claudeAgent"),
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

  return { listRoles, listWorkers, promote, demote, isMaster } satisfies OrchestratorServiceShape;
});

export const OrchestratorServiceLive = Layer.effect(OrchestratorService, makeOrchestratorService);
