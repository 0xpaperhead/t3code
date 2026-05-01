import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";

interface UseThreadIsMasterResult {
  readonly isMaster: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
  /**
   * Toggle the master flag. Optimistically flips local state, then calls the
   * server, and rolls back on failure.
   */
  readonly toggle: () => Promise<void>;
}

/**
 * Tracks whether a thread is currently promoted to orchestrator/master.
 * Refetches on threadId/environmentId change.
 */
export function useThreadIsMaster(
  environmentId: EnvironmentId | null | undefined,
  threadId: ThreadId | null | undefined,
): UseThreadIsMasterResult {
  const [isMaster, setIsMaster] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!environmentId || !threadId) {
      setIsMaster(false);
      setIsLoading(false);
      setError(null);
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setIsMaster(false);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    api.orchestrator
      .isMaster({ threadId })
      .then((result) => {
        if (cancelled) return;
        setIsMaster(result.isMaster);
        setIsLoading(false);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setIsMaster(false);
        setIsLoading(false);
        setError(reason instanceof Error ? reason.message : "Failed to read orchestrator state.");
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, threadId]);

  const toggle = useCallback(async () => {
    if (!environmentId || !threadId) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    const next = !isMaster;
    setIsMaster(next);
    setError(null);
    try {
      if (next) {
        await api.orchestrator.promote({ threadId });
      } else {
        await api.orchestrator.demote({ threadId });
      }
    } catch (reason: unknown) {
      // Roll back on failure.
      setIsMaster(!next);
      setError(reason instanceof Error ? reason.message : "Failed to toggle orchestrator state.");
    }
  }, [environmentId, threadId, isMaster]);

  return { isMaster, isLoading, error, toggle };
}
