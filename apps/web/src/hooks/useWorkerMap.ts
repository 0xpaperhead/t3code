import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";

const REFRESH_INTERVAL_MS = 5_000;
const EMPTY_MAP: ReadonlyMap<ThreadId, ThreadId> = new Map();

/**
 * Polls `orchestrator.listWorkers` and returns a worker→master map for the
 * given environment. Used by the sidebar to render workers nested under
 * their master rather than as flat siblings.
 *
 * Implementation note: this could be event-driven instead of polled, but the
 * worker-spawn rate is low (master decides) and a 5s refresh is well within
 * the perceptual budget for "I just spawned a worker, where is it in the
 * sidebar?". If we want instant updates later, the orchestration event stream
 * already carries enough signal to invalidate this map on `thread.created`
 * with a workerOf binding.
 */
export function useWorkerMap(
  environmentId: EnvironmentId | null | undefined,
): ReadonlyMap<ThreadId, ThreadId> {
  const [map, setMap] = useState<ReadonlyMap<ThreadId, ThreadId>>(EMPTY_MAP);

  useEffect(() => {
    if (!environmentId) {
      setMap(EMPTY_MAP);
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setMap(EMPTY_MAP);
      return;
    }
    let cancelled = false;
    const fetchOnce = () => {
      api.orchestrator
        .listWorkers({})
        .then((result) => {
          if (cancelled) return;
          const next = new Map<ThreadId, ThreadId>();
          for (const worker of result.workers) {
            next.set(worker.threadId, worker.masterThreadId);
          }
          setMap(next);
        })
        .catch(() => {
          // Silent: if listWorkers errors transiently we keep the last map.
          // Deliberate; sidebar shouldn't blank workers because the network
          // hiccupped.
        });
    };
    fetchOnce();
    const intervalId = window.setInterval(fetchOnce, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [environmentId]);

  return map;
}
