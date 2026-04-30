import {
  type EnvironmentId,
  type ExternalSessionScope,
  type ExternalSessionSummary,
  type ProjectId,
} from "@t3tools/contracts";
import { ArrowRightIcon, ClockIcon, FolderOpenIcon, Loader2Icon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { useHandleResumeExternalSession } from "~/hooks/useHandleResumeExternalSession";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { stackedThreadToast, toastManager } from "./ui/toast";

interface ExternalSessionHistoryProps {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onResumed?: () => void;
}

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      sessions: ReadonlyArray<ExternalSessionSummary>;
      truncated: boolean;
      isRefetching: boolean;
    }
  | { status: "error"; message: string };


function ProviderBadge({ provider }: { provider: ExternalSessionSummary["provider"] }) {
  const label = provider === "claude" ? "Claude" : "Codex";
  const tone =
    provider === "claude"
      ? "bg-orange-500/15 text-orange-700 dark:text-orange-400"
      : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1 py-px text-[10px] font-medium leading-none ${tone}`}
    >
      {label}
    </span>
  );
}

export function ExternalSessionHistory({
  cwd,
  environmentId,
  projectId,
  onResumed,
}: ExternalSessionHistoryProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [resumingKey, setResumingKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [scope, setScope] = useState<ExternalSessionScope>("project");
  const handleResume = useHandleResumeExternalSession();

  // Debounce query input by 600ms before hitting the server.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 600);
    return () => window.clearTimeout(handle);
  }, [query]);

  const filteredSessions = useMemo(
    () => (state.status === "ready" ? state.sessions : ([] as ReadonlyArray<ExternalSessionSummary>)),
    [state],
  );

  const onResumeClick = (session: ExternalSessionSummary) => {
    const key = `${session.provider}:${session.sessionId}`;
    setResumingKey(key);
    handleResume({
      environmentId,
      projectId,
      provider: session.provider,
      sessionId: session.sessionId,
      ...(session.title ? { title: session.title } : {}),
    })
      .then(() => {
        const providerLabel = session.provider === "claude" ? "Claude" : "Codex";
        const turnsLabel =
          session.messageCount === 1
            ? "1 prior turn"
            : `${session.messageCount} prior turns`;
        toastManager.add({
          type: "success",
          title: `Resumed ${providerLabel} session`,
          description: `${turnsLabel}. Send a message to continue with full context.`,
        });
        onResumed?.();
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Failed to open the external session.";
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not resume session",
            description: message,
          }),
        );
      })
      .finally(() => {
        setResumingKey(null);
      });
  };

  useEffect(() => {
    let cancelled = false;
    // Preserve already-loaded rows so the list doesn't flicker; show a subtle
    // "searching" indicator on the existing list during refetch.
    setState((current) =>
      current.status === "ready" ? { ...current, isRefetching: true } : { status: "loading" },
    );
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setState({ status: "error", message: "Environment is not connected." });
      return;
    }
    api.externalSessions
      .list({
        cwd,
        scope,
        ...(debouncedQuery ? { query: debouncedQuery } : {}),
      })
      .then((result) => {
        if (cancelled) return;
        setState({
          status: "ready",
          sessions: result.sessions,
          truncated: result.truncated,
          isRefetching: false,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Failed to load CLI session history.";
        setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, environmentId, scope, debouncedQuery]);

  return (
    <div className="flex w-[360px] max-w-(--available-width) flex-col">
      <header className="flex items-center justify-between px-3 pt-2 pb-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Terminal CLI sessions
        </span>
        <div className="flex items-center gap-0 rounded-md border border-input p-0.5 text-[10px]">
          <button
            type="button"
            onClick={() => setScope("project")}
            className={`rounded px-1.5 py-0.5 transition-colors ${
              scope === "project"
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            aria-pressed={scope === "project"}
          >
            This project
          </button>
          <button
            type="button"
            onClick={() => setScope("all")}
            className={`rounded px-1.5 py-0.5 transition-colors ${
              scope === "all"
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            aria-pressed={scope === "all"}
          >
            All
          </button>
        </div>
      </header>
      {state.status === "ready" || query.length > 0 ? (
        <div className="px-3 pb-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title, body, cwd, session id"
              className="w-full rounded-md border border-input bg-background py-1 pl-7 pr-7 text-xs placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label="Search CLI sessions"
            />
            {state.status === "ready" && state.isRefetching ? (
              <Loader2Icon className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 animate-spin text-muted-foreground" />
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="border-b" />
      {state.status === "loading" ? (
        <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          Scanning sessions
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="px-3 py-4 text-sm text-destructive">{state.message}</div>
      ) : null}
      {state.status === "ready" && state.sessions.length === 0 ? (
        <div className="px-3 py-4 text-sm text-muted-foreground">
          {scope === "project" ? (
            <>
              No CLI sessions found for{" "}
              <code className="rounded bg-muted px-1 py-px text-xs">{cwd}</code>.
            </>
          ) : (
            <>No CLI sessions found anywhere.</>
          )}
        </div>
      ) : null}
      {state.status === "ready" &&
      state.sessions.length === 0 &&
      debouncedQuery.length > 0 ? (
        <div className="px-3 py-4 text-sm text-muted-foreground">
          No {scope === "project" ? "sessions in this project" : "sessions"} match "{debouncedQuery}".
        </div>
      ) : null}
      {state.status === "ready" && filteredSessions.length > 0 ? (
        <ul className="max-h-80 overflow-y-auto py-1">
          {filteredSessions.map((session) => {
            const key = `${session.provider}:${session.sessionId}`;
            const isoDate = new Date(session.modifiedAtMs).toISOString();
            const isResuming = resumingKey === key;
            return (
              <li key={key} className="group/row">
                <button
                  type="button"
                  onClick={() => onResumeClick(session)}
                  disabled={resumingKey !== null}
                  className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  title={session.filePath}
                >
                  <div className="flex items-center gap-1.5">
                    <ProviderBadge provider={session.provider} />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                      {session.title?.trim() || (
                        <span className="italic text-muted-foreground">(no preview)</span>
                      )}
                    </span>
                    {isResuming ? (
                      <Loader2Icon className="size-3 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <ClockIcon className="size-2.5" />
                    <span>{formatRelativeTimeLabel(isoDate)}</span>
                    <span aria-hidden>·</span>
                    <span>
                      {session.messageCount} {session.messageCount === 1 ? "turn" : "turns"}
                    </span>
                    {scope === "all" && session.cwd !== cwd ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="truncate" title={session.cwd}>
                          {session.cwd}
                        </span>
                      </>
                    ) : null}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {state.status === "ready" && state.truncated ? (
        <div className="border-t px-3 py-1.5 text-[10px] text-muted-foreground">
          Showing first 200 sessions per provider.
        </div>
      ) : null}
      <div className="border-t px-3 py-2 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <FolderOpenIcon className="size-2.5" />
          Click a session to open it as a new draft thread. Your next message resumes it with full
          prior context.
        </span>
      </div>
    </div>
  );
}
