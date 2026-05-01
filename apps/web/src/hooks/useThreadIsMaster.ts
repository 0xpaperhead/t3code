import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";

interface UseThreadIsMasterResult {
  readonly isMaster: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
  /**
   * Toggle the master flag. Optimistically flips local state, calls the
   * server, and rolls back on failure. Bumps an internal generation
   * counter so any in-flight initial fetch gets discarded — otherwise a
   * slow initial isMaster() can resolve after the click and stomp the
   * optimistic update with the stale `false`.
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
  // Bumped on every effect run AND every toggle. State updates only apply if
  // the generation captured at the start of the operation still matches.
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    const myGeneration = generationRef.current;

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
    setIsLoading(true);
    setError(null);
    api.orchestrator
      .isMaster({ threadId })
      .then((result) => {
        if (myGeneration !== generationRef.current) return;
        setIsMaster(result.isMaster);
        setIsLoading(false);
      })
      .catch((reason: unknown) => {
        if (myGeneration !== generationRef.current) return;
        setIsMaster(false);
        setIsLoading(false);
        setError(reason instanceof Error ? reason.message : "Failed to read orchestrator state.");
      });
  }, [environmentId, threadId]);

  const toggle = useCallback(async () => {
    if (!environmentId || !threadId) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    // Bump first so any in-flight initial fetch's resolution is discarded.
    generationRef.current += 1;
    const myGeneration = generationRef.current;
    const next = !isMaster;
    setIsMaster(next);
    setError(null);
    try {
      if (next) {
        await api.orchestrator.promote({ threadId });
      } else {
        await api.orchestrator.demote({ threadId });
      }
      // No state mutation on success — optimistic update already reflects
      // the new value.
    } catch (reason: unknown) {
      if (myGeneration !== generationRef.current) return;
      setIsMaster(!next);
      setError(reason instanceof Error ? reason.message : "Failed to toggle orchestrator state.");
    }
  }, [environmentId, threadId, isMaster]);

  return { isMaster, isLoading, error, toggle };
}
