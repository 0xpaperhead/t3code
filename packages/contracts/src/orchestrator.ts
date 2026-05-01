import { Schema } from "effect";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OrchestratorPromoteInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestratorPromoteInput = typeof OrchestratorPromoteInput.Type;

export const OrchestratorPromoteResult = Schema.Struct({
  threadId: ThreadId,
  isMaster: Schema.Boolean,
});
export type OrchestratorPromoteResult = typeof OrchestratorPromoteResult.Type;

export const OrchestratorDemoteInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestratorDemoteInput = typeof OrchestratorDemoteInput.Type;

export const OrchestratorDemoteResult = Schema.Struct({
  threadId: ThreadId,
  isMaster: Schema.Boolean,
});
export type OrchestratorDemoteResult = typeof OrchestratorDemoteResult.Type;

export class OrchestratorPromotionError extends Schema.TaggedErrorClass<OrchestratorPromotionError>()(
  "OrchestratorPromotionError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const OrchestratorIsMasterInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestratorIsMasterInput = typeof OrchestratorIsMasterInput.Type;

export const OrchestratorIsMasterResult = Schema.Struct({
  threadId: ThreadId,
  isMaster: Schema.Boolean,
});
export type OrchestratorIsMasterResult = typeof OrchestratorIsMasterResult.Type;

export class OrchestratorIsMasterError extends Schema.TaggedErrorClass<OrchestratorIsMasterError>()(
  "OrchestratorIsMasterError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const OrchestratorWorkerSummary = Schema.Struct({
  threadId: ThreadId,
  masterThreadId: ThreadId,
  projectId: ProjectId,
  spawnedAt: TrimmedNonEmptyString,
  status: Schema.Literals(["running", "idle", "stopped", "errored", "unknown"]),
});
export type OrchestratorWorkerSummary = typeof OrchestratorWorkerSummary.Type;

export const OrchestratorListWorkersInput = Schema.Struct({
  masterThreadId: Schema.optional(ThreadId),
});
export type OrchestratorListWorkersInput = typeof OrchestratorListWorkersInput.Type;

export const OrchestratorListWorkersResult = Schema.Struct({
  workers: Schema.Array(OrchestratorWorkerSummary),
});
export type OrchestratorListWorkersResult = typeof OrchestratorListWorkersResult.Type;

export class OrchestratorListWorkersError extends Schema.TaggedErrorClass<OrchestratorListWorkersError>()(
  "OrchestratorListWorkersError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
