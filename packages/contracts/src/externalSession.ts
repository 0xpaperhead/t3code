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
  cwd: TrimmedNonEmptyString,
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

// Imported timeline entries returned for resumed CLI sessions.
export const ImportedExternalEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("user"),
    id: TrimmedNonEmptyString,
    createdAt: TrimmedNonEmptyString,
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("assistant"),
    id: TrimmedNonEmptyString,
    createdAt: TrimmedNonEmptyString,
    text: Schema.String,
    turnId: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type ImportedExternalEntry = typeof ImportedExternalEntry.Type;

export const ExternalSessionsGetMessagesInput = Schema.Struct({
  provider: ExternalSessionProvider,
  sessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
});
export type ExternalSessionsGetMessagesInput = typeof ExternalSessionsGetMessagesInput.Type;

export const ExternalSessionsGetMessagesResult = Schema.Struct({
  entries: Schema.Array(ImportedExternalEntry),
});
export type ExternalSessionsGetMessagesResult = typeof ExternalSessionsGetMessagesResult.Type;

export class ExternalSessionsGetMessagesError extends Schema.TaggedErrorClass<ExternalSessionsGetMessagesError>()(
  "ExternalSessionsGetMessagesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ExternalResumeMeta = Schema.Struct({
  provider: ExternalSessionProvider,
  sessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  importedAt: TrimmedNonEmptyString,
});
export type ExternalResumeMeta = typeof ExternalResumeMeta.Type;

export const ExternalSessionsGetResumeMetaInput = Schema.Struct({
  threadId: ThreadId,
});
export type ExternalSessionsGetResumeMetaInput = typeof ExternalSessionsGetResumeMetaInput.Type;

export const ExternalSessionsGetResumeMetaResult = Schema.Struct({
  meta: Schema.NullOr(ExternalResumeMeta),
});
export type ExternalSessionsGetResumeMetaResult = typeof ExternalSessionsGetResumeMetaResult.Type;

export class ExternalSessionsGetResumeMetaError extends Schema.TaggedErrorClass<ExternalSessionsGetResumeMetaError>()(
  "ExternalSessionsGetResumeMetaError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
