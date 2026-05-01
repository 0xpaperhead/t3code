import * as NodeOS from "node:os";

import {
  ExternalSessionScanError,
  type ExternalSessionProvider,
  type ExternalSessionSummary,
  type ImportedExternalEntry,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path } from "effect";

import {
  ExternalSessionDirectory,
  type ExternalSessionDirectoryShape,
  type ExternalSessionListResult,
  type ExternalSessionMessagesResult,
} from "../Services/ExternalSessionDirectory.ts";

const DEFAULT_LIMIT_PER_PROVIDER = 200;
const TITLE_MAX_LENGTH = 200;
const TITLE_SCAN_LINE_BUDGET = 200;

interface RawSummary {
  readonly provider: ExternalSessionProvider;
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string | null;
  readonly messageCount: number;
  readonly modifiedAtMs: number;
  readonly filePath: string;
  readonly relevanceScore: number;
}

const TITLE_MATCH_SCORE = 10;
const CWD_MATCH_SCORE = 5;
const SESSION_ID_MATCH_SCORE = 6;
const BODY_MATCH_SCORE = 1;

function tokenizeQuery(query: string): ReadonlyArray<string> {
  // Split on whitespace, strip leading/trailing non-alphanumerics so "find me the..."
  // tokenizes as ["find", "me", "the"] rather than wasting a token on dots.
  return query
    .split(/\s+/)
    .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "").toLowerCase())
    .filter((t) => t.length > 0);
}

interface QueryMatchOutcome {
  readonly matches: boolean;
  readonly score: number;
}

function scoreContentForQuery(
  contents: string,
  title: string | null,
  cwd: string,
  sessionId: string,
  query: string,
): QueryMatchOutcome {
  if (query.length === 0) return { matches: true, score: 0 };
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return { matches: true, score: 0 };

  const titleLower = title?.toLowerCase() ?? "";
  const cwdLower = cwd.toLowerCase();
  const sessionIdLower = sessionId.toLowerCase();
  const contentsLower = contents.toLowerCase();

  let score = 0;
  for (const token of tokens) {
    let tokenScore = 0;
    if (titleLower.includes(token)) tokenScore = Math.max(tokenScore, TITLE_MATCH_SCORE);
    if (sessionIdLower.includes(token)) tokenScore = Math.max(tokenScore, SESSION_ID_MATCH_SCORE);
    if (cwdLower.includes(token)) tokenScore = Math.max(tokenScore, CWD_MATCH_SCORE);
    if (contentsLower.includes(token)) tokenScore = Math.max(tokenScore, BODY_MATCH_SCORE);
    if (tokenScore === 0) {
      // AND semantics: every token must appear somewhere.
      return { matches: false, score: 0 };
    }
    score += tokenScore;
  }
  return { matches: true, score };
}

function toScanError(operation: string) {
  return (cause: unknown) =>
    new ExternalSessionScanError({
      message: `Failed to scan external sessions during ${operation}.`,
      cause,
    });
}

function encodeClaudeCwd(cwd: string): string {
  // Claude Code persists each cwd under ~/.claude/projects/<encoded>/, where the
  // encoding replaces every "/" with "-" in the absolute path.
  // Note: paths containing "-" are ambiguous on round-trip but unambiguous one way.
  return cwd.replace(/\//g, "-");
}

function truncateTitle(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= TITLE_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}

// Tags that wrap CLI- or t3code-injected context preludes. We strip them and any
// content they enclose to surface the user's actual prompt as the title.
const PRELUDE_TAGS = [
  "environment_context",
  "system-reminder",
  "system_reminder",
  "user-prompt-submit-hook",
  "command_message",
  "command_args",
  "command_name",
  "local-command-stdout",
  "local-command-stderr",
];

function stripPreludeBlocks(text: string): string {
  let result = text;
  for (const tag of PRELUDE_TAGS) {
    const block = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi");
    result = result.replace(block, "");
    const selfClosing = new RegExp(`<${tag}\\b[^>]*/>`, "gi");
    result = result.replace(selfClosing, "");
  }
  return result.trim();
}

// Heuristic: a "prelude" message is what the harness or CLI prepends — environment
// context, AGENTS.md dumps, skill manifests, etc. We skip these when picking a title.
function looksLikePrelude(text: string): boolean {
  const stripped = stripPreludeBlocks(text);
  if (stripped.length === 0) return true;
  const lead = stripped.slice(0, 200).trim();
  if (lead.startsWith("# AGENTS.md")) return true;
  if (lead.startsWith("<INSTRUCTIONS>")) return true;
  if (lead.startsWith("<system>")) return true;
  if (/^#+\s+(AGENTS|Codex|System|Skills|Available skills)\b/i.test(lead)) return true;
  return false;
}

// Extract a user-facing prompt from a raw message body. Strips wrapper tags and,
// if the actual prompt is wrapped in <user_query> or similar, surfaces just that.
function cleanUserPromptText(raw: string): string | null {
  const queryMatch = raw.match(/<user[-_ ]query[^>]*>([\s\S]*?)<\/user[-_ ]query>/i);
  if (queryMatch?.[1]) {
    const inner = queryMatch[1].trim();
    if (inner.length > 0) return inner;
  }
  const stripped = stripPreludeBlocks(raw);
  if (stripped.length === 0) return null;
  return stripped;
}

function extractClaudeUserText(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj["type"] !== "user") return null;
  const message = obj["message"];
  if (!message || typeof message !== "object") return null;
  const messageObj = message as Record<string, unknown>;
  if (messageObj["role"] !== "user") return null;
  const content = messageObj["content"];
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const blockObj = block as Record<string, unknown>;
        if (blockObj["type"] === "text" && typeof blockObj["text"] === "string") {
          return blockObj["text"] as string;
        }
      }
    }
  }
  return null;
}

function extractCodexUserText(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  // Codex events with role: "user" appear inside response_item payloads.
  if (obj["type"] !== "response_item") return null;
  const payload = obj["payload"];
  if (!payload || typeof payload !== "object") return null;
  const payloadObj = payload as Record<string, unknown>;
  if (payloadObj["role"] !== "user") return null;
  const content = payloadObj["content"];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const blockObj = block as Record<string, unknown>;
        const textValue = blockObj["text"];
        if (typeof textValue === "string" && textValue.length > 0) {
          return textValue;
        }
      }
    }
  }
  return null;
}

function extractCodexSessionMeta(
  firstLine: string,
): { sessionId: string; cwd: string } | null {
  try {
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    if (parsed["type"] !== "session_meta") return null;
    const payload = parsed["payload"];
    if (!payload || typeof payload !== "object") return null;
    const payloadObj = payload as Record<string, unknown>;
    const id = payloadObj["id"];
    const cwd = payloadObj["cwd"];
    if (typeof id !== "string" || typeof cwd !== "string") return null;
    return { sessionId: id, cwd };
  } catch {
    return null;
  }
}

function summariseClaudeFile(
  filePath: string,
  fileName: string,
  contents: string,
  modifiedAtMs: number,
  expectedCwd: string | null,
  query: string,
): RawSummary | null {
  const sessionId = fileName.endsWith(".jsonl") ? fileName.slice(0, -".jsonl".length) : fileName;
  if (!sessionId) return null;

  const lines = contents.split("\n");
  let title: string | null = null;
  let userMessageCount = 0;
  let observedCwd: string | null = null;
  let scanned = 0;

  for (const rawLine of lines) {
    if (!rawLine) continue;
    if (scanned < TITLE_SCAN_LINE_BUDGET || title === null || observedCwd === null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        scanned += 1;
        continue;
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        if (observedCwd === null && typeof obj["cwd"] === "string") {
          observedCwd = obj["cwd"] as string;
        }
        const userText = extractClaudeUserText(parsed);
        if (userText !== null) {
          if (title === null) {
            const cleaned = cleanUserPromptText(userText);
            if (cleaned !== null && !looksLikePrelude(userText)) {
              title = truncateTitle(cleaned);
            }
          }
          userMessageCount += 1;
        }
      }
      scanned += 1;
    } else {
      // Past the budget for parsing, but still count user lines via cheap regex.
      if (rawLine.includes('"type":"user"') && rawLine.includes('"role":"user"')) {
        userMessageCount += 1;
      }
    }
  }

  const cwd = observedCwd ?? expectedCwd;
  if (cwd === null) return null;
  if (expectedCwd !== null && cwd !== expectedCwd) {
    // Defensive: some old session files may live under a directory name that does not
    // match their recorded cwd. Trust the recorded cwd; skip if it doesn't match.
    return null;
  }

  const match = scoreContentForQuery(contents, title, cwd, sessionId, query);
  if (!match.matches) return null;

  return {
    provider: "claude",
    sessionId,
    cwd,
    title,
    messageCount: userMessageCount,
    modifiedAtMs,
    filePath,
    relevanceScore: match.score,
  };
}

function summariseCodexFile(
  filePath: string,
  contents: string,
  modifiedAtMs: number,
  expectedCwd: string | null,
  query: string,
): RawSummary | null {
  const newlineIdx = contents.indexOf("\n");
  if (newlineIdx === -1) return null;
  const headLine = contents.slice(0, newlineIdx);
  const meta = extractCodexSessionMeta(headLine);
  if (!meta) return null;
  if (expectedCwd !== null && meta.cwd !== expectedCwd) return null;

  const lines = contents.split("\n");
  let title: string | null = null;
  let userMessageCount = 0;
  let scanned = 0;

  for (const rawLine of lines) {
    if (!rawLine) continue;
    if (scanned < TITLE_SCAN_LINE_BUDGET || title === null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        scanned += 1;
        continue;
      }
      const userText = extractCodexUserText(parsed);
      if (userText !== null) {
        if (title === null) {
          const cleaned = cleanUserPromptText(userText);
          if (cleaned !== null && !looksLikePrelude(userText)) {
            title = truncateTitle(cleaned);
          }
        }
        userMessageCount += 1;
      }
      scanned += 1;
    } else {
      if (rawLine.includes('"role":"user"')) {
        userMessageCount += 1;
      }
    }
  }

  const match = scoreContentForQuery(contents, title, meta.cwd, meta.sessionId, query);
  if (!match.matches) return null;

  return {
    provider: "codex",
    sessionId: meta.sessionId,
    cwd: meta.cwd,
    title,
    messageCount: userMessageCount,
    modifiedAtMs,
    filePath,
    relevanceScore: match.score,
  };
}

function compareNewestFirst(a: RawSummary, b: RawSummary): number {
  return b.modifiedAtMs - a.modifiedAtMs;
}

function extractClaudeAssistantText(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj["type"] !== "assistant") return null;
  const message = obj["message"];
  if (!message || typeof message !== "object") return null;
  const messageObj = message as Record<string, unknown>;
  if (messageObj["role"] !== "assistant") return null;
  const content = messageObj["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const blockObj = block as Record<string, unknown>;
        if (blockObj["type"] === "text" && typeof blockObj["text"] === "string") {
          texts.push(blockObj["text"] as string);
        }
      }
    }
    if (texts.length > 0) return texts.join("\n\n");
  }
  return null;
}

function extractClaudeCommonFields(parsed: unknown): {
  uuid?: string;
  timestamp?: string;
} {
  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  const uuid = typeof obj["uuid"] === "string" ? (obj["uuid"] as string) : undefined;
  const timestamp =
    typeof obj["timestamp"] === "string" ? (obj["timestamp"] as string) : undefined;
  return { ...(uuid ? { uuid } : {}), ...(timestamp ? { timestamp } : {}) };
}

function extractCodexAssistantText(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj["type"] !== "response_item") return null;
  const payload = obj["payload"];
  if (!payload || typeof payload !== "object") return null;
  const payloadObj = payload as Record<string, unknown>;
  if (payloadObj["role"] !== "assistant") return null;
  const content = payloadObj["content"];
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const blockObj = block as Record<string, unknown>;
        const text = blockObj["text"];
        if (typeof text === "string" && text.length > 0) texts.push(text);
      }
    }
    if (texts.length > 0) return texts.join("\n\n");
  }
  return null;
}

function parseClaudeImports(
  contents: string,
  sessionId: string,
): ReadonlyArray<ImportedExternalEntry> {
  const out: Array<ImportedExternalEntry> = [];
  let userIndex = 0;
  let assistantIndex = 0;
  for (const rawLine of contents.split("\n")) {
    if (!rawLine) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }
    const userText = extractClaudeUserText(parsed);
    if (userText !== null) {
      const cleaned = cleanUserPromptText(userText);
      // Drop the harness-injected preludes; keep real user prompts only.
      if (cleaned !== null && !looksLikePrelude(userText)) {
        const fields = extractClaudeCommonFields(parsed);
        out.push({
          kind: "user",
          id: `import:user:${sessionId}:${fields.uuid ?? userIndex}`,
          createdAt: fields.timestamp ?? new Date(0).toISOString(),
          text: cleaned,
        });
      }
      userIndex += 1;
      continue;
    }
    const assistantText = extractClaudeAssistantText(parsed);
    if (assistantText !== null && assistantText.trim().length > 0) {
      const fields = extractClaudeCommonFields(parsed);
      out.push({
        kind: "assistant",
        id: `import:assistant:${sessionId}:${fields.uuid ?? assistantIndex}`,
        createdAt: fields.timestamp ?? new Date(0).toISOString(),
        text: assistantText,
        ...(fields.uuid ? { turnId: `import-turn:${fields.uuid}` } : {}),
      });
      assistantIndex += 1;
    }
  }
  return out;
}

function parseCodexImports(
  contents: string,
  sessionId: string,
): ReadonlyArray<ImportedExternalEntry> {
  const out: Array<ImportedExternalEntry> = [];
  let userIndex = 0;
  let assistantIndex = 0;
  for (const rawLine of contents.split("\n")) {
    if (!rawLine) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const timestamp = typeof obj["timestamp"] === "string" ? (obj["timestamp"] as string) : null;
    const userText = extractCodexUserText(parsed);
    if (userText !== null) {
      const cleaned = cleanUserPromptText(userText);
      if (cleaned !== null && !looksLikePrelude(userText)) {
        out.push({
          kind: "user",
          id: `import:user:${sessionId}:${userIndex}`,
          createdAt: timestamp ?? new Date(0).toISOString(),
          text: cleaned,
        });
      }
      userIndex += 1;
      continue;
    }
    const assistantText = extractCodexAssistantText(parsed);
    if (assistantText !== null && assistantText.trim().length > 0) {
      out.push({
        kind: "assistant",
        id: `import:assistant:${sessionId}:${assistantIndex}`,
        createdAt: timestamp ?? new Date(0).toISOString(),
        text: assistantText,
      });
      assistantIndex += 1;
    }
  }
  return out;
}

function compareByRelevanceThenMtime(a: RawSummary, b: RawSummary): number {
  if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
  return b.modifiedAtMs - a.modifiedAtMs;
}

const makeExternalSessionDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const directoryExists = (dir: string) =>
    fs.exists(dir).pipe(Effect.orElseSucceed(() => false));

  const listJsonlFiles = (dir: string) =>
    Effect.gen(function* () {
      const exists = yield* directoryExists(dir);
      if (!exists) return [] as ReadonlyArray<string>;
      const entries = yield* fs.readDirectory(dir).pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
      );
      return entries.filter((entry) => entry.endsWith(".jsonl"));
    });

  const safeStat = (filePath: string) =>
    fs.stat(filePath).pipe(Effect.option);

  const safeReadFile = (filePath: string) =>
    fs.readFileString(filePath).pipe(Effect.option);

  const readClaudeForCwd = (
    expectedCwd: string,
    limit: number,
    query: string,
  ): Effect.Effect<ReadonlyArray<RawSummary>, never> =>
    Effect.gen(function* () {
      const home = NodeOS.homedir();
      const projectsRoot = path.join(home, ".claude", "projects");
      const encodedCwd = encodeClaudeCwd(expectedCwd);
      const dir = path.join(projectsRoot, encodedCwd);

      const fileNames = yield* listJsonlFiles(dir);

      // Read mtimes first so we can sort and stop at the limit.
      const stats = yield* Effect.forEach(
        fileNames,
        (fileName) =>
          Effect.gen(function* () {
            const fullPath = path.join(dir, fileName);
            const stat = yield* safeStat(fullPath);
            if (stat._tag === "None") return null;
            const mtime = stat.value.mtime;
            const mtimeMs = mtime._tag === "Some" ? mtime.value.getTime() : 0;
            return { fileName, fullPath, mtimeMs };
          }),
        { concurrency: 16 },
      );

      const candidates = stats
        .filter((entry): entry is { fileName: string; fullPath: string; mtimeMs: number } => entry !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      const summaries = yield* Effect.forEach(
        candidates,
        (candidate) =>
          Effect.gen(function* () {
            const contentsOpt = yield* safeReadFile(candidate.fullPath);
            if (contentsOpt._tag === "None") return null;
            return summariseClaudeFile(
              candidate.fullPath,
              candidate.fileName,
              contentsOpt.value,
              candidate.mtimeMs,
              expectedCwd,
              query,
            );
          }),
        { concurrency: 8 },
      );

      return summaries.filter((value): value is RawSummary => value !== null).slice(0, limit);
    });

  const readClaudeAll = (
    limit: number,
    query: string,
  ): Effect.Effect<ReadonlyArray<RawSummary>, never> =>
    Effect.gen(function* () {
      const home = NodeOS.homedir();
      const projectsRoot = path.join(home, ".claude", "projects");
      const exists = yield* directoryExists(projectsRoot);
      if (!exists) return [] as ReadonlyArray<RawSummary>;

      const projectDirs = yield* fs
        .readDirectory(projectsRoot)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

      const allFiles: Array<{ fileName: string; fullPath: string }> = [];
      for (const projectDir of projectDirs) {
        const dir = path.join(projectsRoot, projectDir);
        const fileNames = yield* listJsonlFiles(dir);
        for (const fileName of fileNames) {
          allFiles.push({ fileName, fullPath: path.join(dir, fileName) });
        }
      }

      const stats = yield* Effect.forEach(
        allFiles,
        (entry) =>
          Effect.gen(function* () {
            const stat = yield* safeStat(entry.fullPath);
            if (stat._tag === "None") return null;
            const mtime = stat.value.mtime;
            const mtimeMs = mtime._tag === "Some" ? mtime.value.getTime() : 0;
            return { ...entry, mtimeMs };
          }),
        { concurrency: 16 },
      );

      const candidates = stats
        .filter(
          (entry): entry is { fileName: string; fullPath: string; mtimeMs: number } =>
            entry !== null,
        )
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      const summaries = yield* Effect.forEach(
        candidates,
        (candidate) =>
          Effect.gen(function* () {
            const contentsOpt = yield* safeReadFile(candidate.fullPath);
            if (contentsOpt._tag === "None") return null;
            return summariseClaudeFile(
              candidate.fullPath,
              candidate.fileName,
              contentsOpt.value,
              candidate.mtimeMs,
              null,
              query,
            );
          }),
        { concurrency: 8 },
      );

      return summaries.filter((value): value is RawSummary => value !== null).slice(0, limit);
    });

  const readCodexForCwd = (
    expectedCwd: string | null,
    limit: number,
    query: string,
  ): Effect.Effect<ReadonlyArray<RawSummary>, never> =>
    Effect.gen(function* () {
      const home = NodeOS.homedir();
      const sessionsRoot = path.join(home, ".codex", "sessions");

      const exists = yield* directoryExists(sessionsRoot);
      if (!exists) return [] as ReadonlyArray<RawSummary>;

      const yearDirs = yield* fs.readDirectory(sessionsRoot).pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
      );

      const allFilePaths: Array<string> = [];
      for (const year of yearDirs) {
        const yearPath = path.join(sessionsRoot, year);
        const months = yield* fs
          .readDirectory(yearPath)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        for (const month of months) {
          const monthPath = path.join(yearPath, month);
          const days = yield* fs
            .readDirectory(monthPath)
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
          for (const day of days) {
            const dayPath = path.join(monthPath, day);
            const files = yield* fs
              .readDirectory(dayPath)
              .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
            for (const file of files) {
              if (file.endsWith(".jsonl")) {
                allFilePaths.push(path.join(dayPath, file));
              }
            }
          }
        }
      }

      const stats = yield* Effect.forEach(
        allFilePaths,
        (fullPath) =>
          Effect.gen(function* () {
            const stat = yield* safeStat(fullPath);
            if (stat._tag === "None") return null;
            const mtime = stat.value.mtime;
            const mtimeMs = mtime._tag === "Some" ? mtime.value.getTime() : 0;
            return { fullPath, mtimeMs };
          }),
        { concurrency: 16 },
      );

      const candidatesByMtime = stats
        .filter((entry): entry is { fullPath: string; mtimeMs: number } => entry !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      // We don't know cwd until we read the first line, so iterate newest-first
      // and stop once we have `limit` matches.
      const matches: Array<RawSummary> = [];
      for (const candidate of candidatesByMtime) {
        if (matches.length >= limit) break;
        const contentsOpt = yield* safeReadFile(candidate.fullPath);
        if (contentsOpt._tag === "None") continue;
        const summary = summariseCodexFile(
          candidate.fullPath,
          contentsOpt.value,
          candidate.mtimeMs,
          expectedCwd,
          query,
        );
        if (summary === null) continue;
        matches.push(summary);
      }

      return matches;
    });

  const listForCwd: ExternalSessionDirectoryShape["listForCwd"] = (cwd, options) => {
    const scope = options?.scope ?? "project";
    const query = (options?.query ?? "").trim().toLowerCase();
    const limit = options?.limitPerProvider ?? DEFAULT_LIMIT_PER_PROVIDER;
    return Effect.gen(function* () {
      const claude = scope === "all"
        ? yield* readClaudeAll(limit, query)
        : yield* readClaudeForCwd(cwd, limit, query);
      const codex = scope === "all"
        ? yield* readCodexForCwd(null, limit, query)
        : yield* readCodexForCwd(cwd, limit, query);
      const truncated = claude.length >= limit || codex.length >= limit;
      // When a query is active, surface the most relevant results first; otherwise
      // fall back to newest-first by mtime.
      const combined = [...claude, ...codex].sort(
        query.length > 0 ? compareByRelevanceThenMtime : compareNewestFirst,
      );
      const sessions: ReadonlyArray<ExternalSessionSummary> = combined.map((entry) => ({
        provider: entry.provider,
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        title: entry.title,
        messageCount: entry.messageCount,
        modifiedAtMs: entry.modifiedAtMs,
        filePath: entry.filePath,
      }));
      return { sessions, truncated } satisfies ExternalSessionListResult;
    }).pipe(Effect.mapError(toScanError("ExternalSessionDirectory.listForCwd")));
  };

  const getMessages: ExternalSessionDirectoryShape["getMessages"] = (input) =>
    Effect.gen(function* () {
      const home = NodeOS.homedir();
      let filePath: string;
      if (input.provider === "claude") {
        const projectsRoot = path.join(home, ".claude", "projects");
        const dir = path.join(projectsRoot, encodeClaudeCwd(input.cwd));
        filePath = path.join(dir, `${input.sessionId}.jsonl`);
      } else {
        // Codex sessions are bucketed by date. We don't know the exact path from the
        // sessionId alone, so search for it. Cheap because we already filter by mtime.
        const sessionsRoot = path.join(home, ".codex", "sessions");
        const found = yield* findCodexFileBySessionId(sessionsRoot, input.sessionId);
        if (!found) {
          return { entries: [] } satisfies ExternalSessionMessagesResult;
        }
        filePath = found;
      }
      const contentsOpt = yield* fs.readFileString(filePath).pipe(Effect.option);
      if (contentsOpt._tag === "None") {
        return { entries: [] } satisfies ExternalSessionMessagesResult;
      }
      const entries =
        input.provider === "claude"
          ? parseClaudeImports(contentsOpt.value, input.sessionId)
          : parseCodexImports(contentsOpt.value, input.sessionId);
      return { entries } satisfies ExternalSessionMessagesResult;
    }).pipe(Effect.mapError(toScanError("ExternalSessionDirectory.getMessages")));

  const findCodexFileBySessionId = (
    sessionsRoot: string,
    sessionId: string,
  ): Effect.Effect<string | null, never> =>
    Effect.gen(function* () {
      const exists = yield* directoryExists(sessionsRoot);
      if (!exists) return null;
      const yearDirs = yield* fs
        .readDirectory(sessionsRoot)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      for (const year of yearDirs) {
        const yearPath = path.join(sessionsRoot, year);
        const months = yield* fs
          .readDirectory(yearPath)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        for (const month of months) {
          const monthPath = path.join(yearPath, month);
          const days = yield* fs
            .readDirectory(monthPath)
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
          for (const day of days) {
            const dayPath = path.join(monthPath, day);
            const files = yield* fs
              .readDirectory(dayPath)
              .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
            for (const file of files) {
              if (file.endsWith(`${sessionId}.jsonl`)) {
                return path.join(dayPath, file);
              }
            }
          }
        }
      }
      return null;
    });

  return { listForCwd, getMessages } satisfies ExternalSessionDirectoryShape;
});

export const ExternalSessionDirectoryLive = Layer.effect(
  ExternalSessionDirectory,
  makeExternalSessionDirectory,
);
