/**
 * Service bundle that ClaudeAdapter consumes at session-start to detect
 * orchestrator threads and attach the in-process MCP server.
 *
 * Wrapping these four services into a single tag lets `ClaudeDriverEnv`
 * declare a single dependency instead of four, keeping the driver
 * contract narrow while still flowing the live services in via the
 * runtime layer composition.
 */
import { Context, Effect, Layer } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { OrchestratorService, type OrchestratorServiceShape } from "./OrchestratorService.ts";

export interface ClaudeOrchestratorBridgeShape {
  readonly orchestratorService: OrchestratorServiceShape;
  readonly providerSessionDirectory: ProviderSessionDirectoryShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
}

export class ClaudeOrchestratorBridge extends Context.Service<
  ClaudeOrchestratorBridge,
  ClaudeOrchestratorBridgeShape
>()("t3/orchestrator/ClaudeOrchestratorBridge") {}

const makeClaudeOrchestratorBridge = Effect.gen(function* () {
  const orchestratorService = yield* OrchestratorService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  return {
    orchestratorService,
    providerSessionDirectory,
    projectionSnapshotQuery,
    orchestrationEngine,
  } satisfies ClaudeOrchestratorBridgeShape;
});

export const ClaudeOrchestratorBridgeLive = Layer.effect(
  ClaudeOrchestratorBridge,
  makeClaudeOrchestratorBridge,
);

/**
 * A no-op bridge for tests that don't exercise the orchestrator path.
 * `isMaster` always returns false, so the orchestrator MCP server is never
 * attached.
 */
export const NoOpClaudeOrchestratorBridge: ClaudeOrchestratorBridgeShape = {
  orchestratorService: {
    isMaster: () => Effect.succeed(false),
    listWorkers: () => Effect.succeed([]),
    promote: (threadId) => Effect.succeed({ threadId, isMaster: true }),
    demote: (threadId) => Effect.succeed({ threadId, isMaster: false }),
  },
  // The remaining services are never invoked when isMaster() returns false.
  providerSessionDirectory: {} as ProviderSessionDirectoryShape,
  projectionSnapshotQuery: {} as ProjectionSnapshotQueryShape,
  orchestrationEngine: {} as OrchestrationEngineShape,
};

export const NoOpClaudeOrchestratorBridgeLayer = Layer.succeed(
  ClaudeOrchestratorBridge,
  NoOpClaudeOrchestratorBridge,
);
