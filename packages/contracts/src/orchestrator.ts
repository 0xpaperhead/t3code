import { Schema } from "effect";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OrchestratorRole = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  systemPrompt: TrimmedNonEmptyString,
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  disallowedTools: Schema.optional(Schema.Array(Schema.String)),
  permissionMode: Schema.optional(
    Schema.Literals(["default", "acceptEdits", "bypassPermissions"]),
  ),
});
export type OrchestratorRole = typeof OrchestratorRole.Type;

export const OrchestratorListRolesInput = Schema.Struct({});
export type OrchestratorListRolesInput = typeof OrchestratorListRolesInput.Type;

export const OrchestratorListRolesResult = Schema.Struct({
  roles: Schema.Array(OrchestratorRole),
});
export type OrchestratorListRolesResult = typeof OrchestratorListRolesResult.Type;

export class OrchestratorListRolesError extends Schema.TaggedErrorClass<OrchestratorListRolesError>()(
  "OrchestratorListRolesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

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

export const OrchestratorWorkerSummary = Schema.Struct({
  threadId: ThreadId,
  masterThreadId: ThreadId,
  projectId: ProjectId,
  roleId: Schema.optional(TrimmedNonEmptyString),
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
