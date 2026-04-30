import type {
  ExternalSessionScanError,
  ExternalSessionScope,
  ExternalSessionSummary,
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

export interface ExternalSessionDirectoryShape {
  readonly listForCwd: (
    cwd: string,
    options?: ExternalSessionListOptions,
  ) => Effect.Effect<ExternalSessionListResult, ExternalSessionScanError>;
}

export class ExternalSessionDirectory extends Context.Service<
  ExternalSessionDirectory,
  ExternalSessionDirectoryShape
>()("t3/provider/Services/ExternalSessionDirectory") {}
