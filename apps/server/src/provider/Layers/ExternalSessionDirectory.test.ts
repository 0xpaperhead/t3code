import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { ExternalSessionDirectoryLive } from "./ExternalSessionDirectory.ts";
import { ExternalSessionDirectory } from "../Services/ExternalSessionDirectory.ts";

const TestRuntime = ExternalSessionDirectoryLive.pipe(
  Layer.provideMerge(NodeServices.layer),
);

describe("ExternalSessionDirectory", () => {
  it.effect("returns no sessions for an unknown cwd", () =>
    Effect.gen(function* () {
      const directory = yield* ExternalSessionDirectory;
      const result = yield* directory.listForCwd(
        "/this/path/does/not/exist/anywhere/zzz",
      );
      expect(result.sessions).toEqual([]);
      expect(result.truncated).toBe(false);
    }).pipe(Effect.provide(TestRuntime)),
  );

  it.effect("scans Claude sessions for a cwd that has them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = NodeOS.homedir();
      const claudeProjects = `${home}/.claude/projects`;
      const exists = yield* fs.exists(claudeProjects).pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        // Skip on CI / fresh machines without Claude Code installed.
        return;
      }
      const directory = yield* ExternalSessionDirectory;
      // Look up sessions for the user's home dir.
      const result = yield* directory.listForCwd(home);
      // We can't assert a specific count, but we can assert shape and ordering.
      let lastMtime = Number.POSITIVE_INFINITY;
      for (const session of result.sessions) {
        expect(["claude", "codex"]).toContain(session.provider);
        expect(session.cwd).toBe(home);
        expect(session.sessionId.length).toBeGreaterThan(0);
        expect(session.filePath.endsWith(".jsonl")).toBe(true);
        expect(session.modifiedAtMs).toBeGreaterThan(0);
        // Sorted newest first.
        expect(session.modifiedAtMs).toBeLessThanOrEqual(lastMtime);
        lastMtime = session.modifiedAtMs;
      }
    }).pipe(Effect.provide(TestRuntime)),
  );
});
