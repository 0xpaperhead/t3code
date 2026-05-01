import {
  type EnvironmentId,
  type ImportedExternalEntry,
  MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { type TimelineEntry } from "../session-logic";
import { type ChatMessage } from "../types";

export interface ExternalImportState {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly importedAt: string | null;
  readonly provider: "claude" | "codex" | null;
  readonly priorTurnCount: number;
  readonly isLoading: boolean;
  readonly error: string | null;
}

const EMPTY_STATE: ExternalImportState = {
  entries: [],
  importedAt: null,
  provider: null,
  priorTurnCount: 0,
  isLoading: false,
  error: null,
};

const DIVIDER_ID = "import-divider";

function entryToTimeline(entry: ImportedExternalEntry): TimelineEntry {
  const message: ChatMessage = {
    id: MessageId.make(entry.id),
    role: entry.kind,
    text: entry.text,
    createdAt: entry.createdAt,
    streaming: false,
    turnId: null,
  };
  return {
    id: entry.id,
    kind: "message",
    createdAt: entry.createdAt,
    message,
  };
}

function buildDivider(importedAt: string, provider: "claude" | "codex", priorTurnCount: number): TimelineEntry {
  const providerLabel = provider === "claude" ? "Claude" : "Codex";
  const turnsLabel =
    priorTurnCount === 1
      ? "1 prior turn"
      : `${priorTurnCount} prior turns`;
  const message: ChatMessage = {
    id: MessageId.make(DIVIDER_ID),
    role: "system",
    text: `Resumed ${providerLabel} session · ${turnsLabel}. Conversation below is live.`,
    createdAt: importedAt,
    streaming: false,
    turnId: null,
  };
  return {
    id: DIVIDER_ID,
    kind: "message",
    createdAt: importedAt,
    message,
  };
}

/**
 * Fetches imported turns for a thread that was resumed from an external CLI session
 * and returns them as TimelineEntry[] ready to prepend to the live timeline.
 *
 * Returns an empty list for threads that weren't resumed (no marker in binding).
 */
export function useExternalSessionImports(
  environmentId: EnvironmentId | null | undefined,
  threadId: ThreadId | null | undefined,
): ExternalImportState {
  const [state, setState] = useState<ExternalImportState>(EMPTY_STATE);

  useEffect(() => {
    if (!environmentId || !threadId) {
      setState(EMPTY_STATE);
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setState(EMPTY_STATE);
      return;
    }
    let cancelled = false;
    setState((current) => ({ ...current, isLoading: true, error: null }));
    (async () => {
      try {
        const metaResult = await api.externalSessions.getResumeMeta({ threadId });
        if (cancelled) return;
        const meta = metaResult.meta;
        if (!meta) {
          setState(EMPTY_STATE);
          return;
        }
        const messages = await api.externalSessions.getMessages({
          provider: meta.provider,
          sessionId: meta.sessionId,
          cwd: meta.cwd,
        });
        if (cancelled) return;
        const timeline = messages.entries.map(entryToTimeline);
        const userTurnCount = messages.entries.filter((e) => e.kind === "user").length;
        const withDivider =
          timeline.length > 0
            ? [...timeline, buildDivider(meta.importedAt, meta.provider, userTurnCount)]
            : [];
        setState({
          entries: withDivider,
          importedAt: meta.importedAt,
          provider: meta.provider,
          priorTurnCount: userTurnCount,
          isLoading: false,
          error: null,
        });
      } catch (error: unknown) {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Failed to load imported history.";
        setState({ ...EMPTY_STATE, error: message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId, threadId]);

  return state;
}
