import {
  type EnvironmentId,
  type ExternalSessionProvider,
  type ProjectId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { buildThreadRouteParams } from "../threadRoutes";

interface ResumeExternalSessionInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly provider: ExternalSessionProvider;
  readonly sessionId: string;
  readonly title?: string;
}

export function useHandleResumeExternalSession() {
  const router = useRouter();

  return useCallback(
    async (input: ResumeExternalSessionInput): Promise<void> => {
      const api = readEnvironmentApi(input.environmentId);
      if (!api) {
        throw new Error("Environment is not connected.");
      }

      // Server creates the thread (with the resumeCursor pre-seeded) and returns its threadId.
      const result = await api.externalSessions.bindResume({
        projectId: input.projectId,
        provider: input.provider,
        sessionId: input.sessionId,
        ...(input.title ? { title: input.title } : {}),
      });

      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: input.environmentId,
          threadId: result.threadId,
        }),
      });
    },
    [router],
  );
}
