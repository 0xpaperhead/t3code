/**
 * In-process MCP server registered with the Claude Agent SDK when a thread is
 * promoted to "master" / orchestrator. Exposes tools the master can call to
 * spawn and observe worker threads.
 *
 * The Claude SDK's `createSdkMcpServer` runs in the same Node process — no stdio
 * subprocess, no HTTP loopback. Tool handlers receive plain JSON args and run
 * t3code's orchestration via the `runEffect` callback supplied at construction.
 *
 * v1 tools:
 *   - list_roles         (enumerate available worker roles)
 *   - list_workers       (enumerate workers spawned by this master)
 *   - spawn_worker       (create a worker thread + send its first task)
 *   - read_worker_output (read a worker's current message transcript)
 *
 * Future tools: wait_for_worker, send_to_worker, kill_worker, wait_for_any.
 */

import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OrchestratorRole,
  type OrchestratorWorkerSummary,
  ProviderDriverKind,
  ThreadId,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Option } from "effect";
import { z } from "zod";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory.ts";
import type { OrchestratorServiceShape } from "./OrchestratorService.ts";

interface OrchestratorMcpServerDependencies {
  readonly masterThreadId: string;
  readonly orchestratorService: OrchestratorServiceShape;
  readonly providerSessionDirectory: ProviderSessionDirectoryShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
}

function textResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  return { content: [{ type: "text", text }], isError: true };
}

function jsonText(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return textResult(JSON.stringify(value, null, 2));
}

export function createOrchestratorMcpServer(deps: OrchestratorMcpServerDependencies) {
  const {
    masterThreadId,
    orchestratorService,
    providerSessionDirectory,
    projectionSnapshotQuery,
    orchestrationEngine,
  } = deps;

  // Helper: run an Effect from inside a tool handler. Tool handlers are async
  // functions invoked by the SDK outside Effect's structured context; we have
  // pre-resolved service instances on `deps`, so the effects we compose here
  // typically have no requirements and Effect.runPromise is sufficient.
  const runEffect = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
    Effect.runPromise(effect as Effect.Effect<A, never, never>);

  // ----- list_roles -----------------------------------------------------
  const listRolesTool = tool(
    "list_roles",
    "List worker roles you can spawn. Each role pre-configures a system prompt and (optionally) tool restrictions.",
    {},
    async () => {
      try {
        const roles = await runEffect(orchestratorService.listRoles());
        const summaries = roles.map((role: OrchestratorRole) => ({
          id: role.id,
          name: role.name,
          description: role.description ?? null,
          allowedTools: role.allowedTools ?? null,
          disallowedTools: role.disallowedTools ?? null,
          permissionMode: role.permissionMode ?? null,
        }));
        return jsonText({ roles: summaries });
      } catch (error) {
        return errorResult(
          `list_roles failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  // ----- list_workers ---------------------------------------------------
  const listWorkersTool = tool(
    "list_workers",
    "List worker threads you have spawned. Returns each worker's threadId, role, status, and spawnedAt.",
    {},
    async () => {
      try {
        const workers = await runEffect(
          orchestratorService.listWorkers({ masterThreadId }),
        );
        return jsonText({
          workers: workers.map((w: OrchestratorWorkerSummary) => ({
            threadId: w.threadId,
            roleId: w.roleId ?? null,
            status: w.status,
            spawnedAt: w.spawnedAt,
          })),
        });
      } catch (error) {
        return errorResult(
          `list_workers failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  // ----- spawn_worker ---------------------------------------------------
  const spawnWorkerInputSchema = {
    task: z.string().min(1).describe("The first prompt the worker will receive."),
    role: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional role id (call list_roles to see available roles). If omitted, you can supply systemPrompt/allowedTools/disallowedTools inline.",
      ),
    systemPrompt: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Inline system prompt for the worker, used when role is omitted or to override the role's system prompt.",
      ),
    allowedTools: z
      .array(z.string())
      .optional()
      .describe("Optional whitelist of tool names the worker may use."),
    disallowedTools: z
      .array(z.string())
      .optional()
      .describe("Optional blacklist of tool names the worker may not use."),
    title: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("Optional thread title. Defaults to the role's name (or 'Worker')."),
  };

  const spawnWorkerTool = tool(
    "spawn_worker",
    "Spawn a worker thread that will execute `task`. Returns immediately with the worker's threadId; the worker runs asynchronously. Use list_workers / read_worker_output to observe progress.",
    spawnWorkerInputSchema,
    async (args) => {
      try {
        const program = Effect.gen(function* () {
          // Resolve role config (inline overrides take precedence per field).
          const resolvedRole = args.role
            ? yield* Effect.promise(() =>
                runEffect(
                  Effect.gen(function* () {
                    const roles = yield* orchestratorService.listRoles();
                    return roles.find((r) => r.id === args.role) ?? null;
                  }),
                ),
              )
            : null;
          const systemPrompt =
            args.systemPrompt ?? resolvedRole?.systemPrompt ?? "You are a helpful coding assistant.";
          const allowedTools = args.allowedTools ?? resolvedRole?.allowedTools;
          const disallowedTools = args.disallowedTools ?? resolvedRole?.disallowedTools;
          const permissionMode = resolvedRole?.permissionMode ?? "default";
          const titleSeed = args.title ?? resolvedRole?.name ?? "Worker";

          // Look up master's project so the worker is scoped to the same project.
          const masterShellOpt = yield* projectionSnapshotQuery
            .getThreadShellById(ThreadId.make(masterThreadId))
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isNone(masterShellOpt)) {
            return yield* Effect.fail(
              new Error("Master thread not found in projection — cannot resolve project."),
            );
          }
          const masterShell = masterShellOpt.value;
          const projectId = masterShell.projectId;
          const workerThreadId = ThreadId.make(crypto.randomUUID());
          const spawnedAt = new Date().toISOString();

          const claudeDriverKind = ProviderDriverKind.make("claudeAgent");
          const claudeInstanceId = defaultInstanceIdForDriver(claudeDriverKind);
          const claudeDefaultModel = DEFAULT_MODEL_BY_PROVIDER[claudeDriverKind] ?? "claude-sonnet-4-6";

          // Pre-seed the worker binding with role config + workerOf marker BEFORE
          // dispatching thread.create, so the adapter can read them on the first turn.
          // providerInstanceId is required by upsert validation post multi-provider
          // refactor — routes the runtime to the configured Claude instance.
          yield* providerSessionDirectory.upsert({
            threadId: workerThreadId,
            provider: claudeDriverKind,
            providerInstanceId: claudeInstanceId,
            adapterKey: "claudeAgent",
            status: "stopped",
            runtimeMode: "full-access",
            runtimePayload: {
              workerOf: {
                masterThreadId,
                ...(args.role ? { roleId: args.role } : {}),
                spawnedAt,
                projectId,
              },
              workerConfig: {
                systemPrompt,
                ...(allowedTools ? { allowedTools } : {}),
                ...(disallowedTools ? { disallowedTools } : {}),
                permissionMode,
              },
            },
          });

          // Create the thread.
          yield* orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`worker-create:${crypto.randomUUID()}`),
            threadId: workerThreadId,
            projectId,
            title: titleSeed,
            modelSelection: {
              instanceId: claudeInstanceId,
              model: claudeDefaultModel,
            },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: spawnedAt,
          });

          // Send the first turn (the task).
          yield* orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`worker-turn:${crypto.randomUUID()}`),
            threadId: workerThreadId,
            message: {
              messageId: MessageId.make(crypto.randomUUID()),
              role: "user",
              text: args.task,
              attachments: [],
            },
            modelSelection: {
              instanceId: claudeInstanceId,
              model: claudeDefaultModel,
            },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: new Date().toISOString(),
          });

          return { threadId: workerThreadId, status: "running" as const };
        });

        const result = await runEffect(program);
        return jsonText(result);
      } catch (error) {
        return errorResult(
          `spawn_worker failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  // ----- read_worker_output --------------------------------------------
  const readWorkerOutputInputSchema = {
    threadId: z.string().min(1).describe("The worker thread's id."),
  };

  const readWorkerOutputTool = tool(
    "read_worker_output",
    "Read the current message transcript of a worker thread. Returns user/assistant turns; tool actions are summarized.",
    readWorkerOutputInputSchema,
    async (args) => {
      try {
        const detailOpt = await runEffect(
          projectionSnapshotQuery
            .getThreadDetailById(ThreadId.make(args.threadId))
            .pipe(Effect.orElseSucceed(() => Option.none())),
        );
        if (Option.isNone(detailOpt)) {
          return errorResult(`Worker thread '${args.threadId}' not found.`);
        }
        const detail = detailOpt.value;
        const messages = (detail.messages ?? []).map((message) => ({
          id: message.id,
          role: message.role,
          text:
            typeof message.text === "string"
              ? message.text
              : "(non-text content)",
          createdAt: message.createdAt,
        }));
        return jsonText({
          threadId: args.threadId,
          messageCount: messages.length,
          messages,
        });
      } catch (error) {
        return errorResult(
          `read_worker_output failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  return createSdkMcpServer({
    name: "t3_orchestrator",
    version: "0.1.0",
    tools: [listRolesTool, listWorkersTool, spawnWorkerTool, readWorkerOutputTool],
  });
}
