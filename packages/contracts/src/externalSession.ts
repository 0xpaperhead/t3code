import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const EXTERNAL_SESSION_TITLE_MAX_LENGTH = 200;

export const ExternalSessionProvider = Schema.Literals(["claude", "codex"]);
export type ExternalSessionProvider = typeof ExternalSessionProvider.Type;

export const ExternalSessionSummary = Schema.Struct({
  provider: ExternalSessionProvider,
  sessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String.check(Schema.isMaxLength(EXTERNAL_SESSION_TITLE_MAX_LENGTH))),
  messageCount: NonNegativeInt,
  modifiedAtMs: NonNegativeInt,
  filePath: TrimmedNonEmptyString,
});
export type ExternalSessionSummary = typeof ExternalSessionSummary.Type;

export const ExternalSessionScope = Schema.Literals(["project", "all"]);
export type ExternalSessionScope = typeof ExternalSessionScope.Type;

export const ExternalSessionsListInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  scope: Schema.optional(ExternalSessionScope),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  limitPerProvider: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(500))),
});
export type ExternalSessionsListInput = typeof ExternalSessionsListInput.Type;

export const ExternalSessionsListResult = Schema.Struct({
  sessions: Schema.Array(ExternalSessionSummary),
  truncated: Schema.Boolean,
});
export type ExternalSessionsListResult = typeof ExternalSessionsListResult.Type;

export class ExternalSessionScanError extends Schema.TaggedErrorClass<ExternalSessionScanError>()(
  "ExternalSessionScanError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ExternalSessionsBindResumeInput = Schema.Struct({
  projectId: ProjectId,
  provider: ExternalSessionProvider,
  sessionId: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type ExternalSessionsBindResumeInput = typeof ExternalSessionsBindResumeInput.Type;

export const ExternalSessionsBindResumeResult = Schema.Struct({
  threadId: ThreadId,
});
export type ExternalSessionsBindResumeResult = typeof ExternalSessionsBindResumeResult.Type;

export class ExternalSessionsBindResumeError extends Schema.TaggedErrorClass<ExternalSessionsBindResumeError>()(
  "ExternalSessionsBindResumeError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
