import type {
  ExternalSessionProvider,
  ExternalSessionScanError,
  ExternalSessionScope,
  ExternalSessionSummary,
  ImportedExternalEntry,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface ExternalSessionListResult {
  readonly sessions: ReadonlyArray<ExternalSessionSummary>;
  readonly truncated: boolean;
}

export interface ExternalSessionListOptions {
  readonly scope?: ExternalSessionScope;
  readonly query?: string;
  readonly limitPerProvider?: number;
}

export interface ExternalSessionMessagesResult {
  readonly entries: ReadonlyArray<ImportedExternalEntry>;
}

export interface ExternalSessionDirectoryShape {
  readonly listForCwd: (
    cwd: string,
    options?: ExternalSessionListOptions,
  ) => Effect.Effect<ExternalSessionListResult, ExternalSessionScanError>;

  readonly getMessages: (input: {
    readonly provider: ExternalSessionProvider;
    readonly sessionId: string;
    readonly cwd: string;
  }) => Effect.Effect<ExternalSessionMessagesResult, ExternalSessionScanError>;
}

export class ExternalSessionDirectory extends Context.Service<
  ExternalSessionDirectory,
  ExternalSessionDirectoryShape
>()("t3/provider/Services/ExternalSessionDirectory") {}
