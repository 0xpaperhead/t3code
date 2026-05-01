import * as NodeOS from "node:os";

import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

export const OrchestratorRoleSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(400))),
  systemPrompt: Schema.String.check(Schema.isMinLength(1)),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  disallowedTools: Schema.optional(Schema.Array(Schema.String)),
  permissionMode: Schema.optional(
    Schema.Literals(["default", "acceptEdits", "bypassPermissions"]),
  ),
});
export type OrchestratorRole = typeof OrchestratorRoleSchema.Type;

const RolesFileSchema = Schema.Struct({
  roles: Schema.Array(OrchestratorRoleSchema),
});

// Built-in roles. Inspired by agent-grid's defaults.
export const BUILTIN_ROLES: ReadonlyArray<OrchestratorRole> = [
  {
    id: "builder",
    name: "Builder",
    description: "Implements features, can read and write code freely.",
    systemPrompt:
      "You are a Builder. You implement features and write production code with care. You favor small, well-tested changes. Run tests after edits when reasonable.",
  },
  {
    id: "qa",
    name: "QA Reviewer",
    description: "Reviews changes without modifying them. Read-only.",
    systemPrompt:
      "You are a QA Reviewer. Review staged or recent uncommitted changes for correctness, edge cases, and consistency with the rest of the codebase. Report findings as a numbered list with concrete file:line references. Do NOT modify code.",
    disallowedTools: ["Write", "Edit", "NotebookEdit"],
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Investigates the codebase, reports findings without making changes.",
    systemPrompt:
      "You are a Researcher. Your job is to read code and report findings. Search broadly, summarize what you find with file paths and short excerpts. Do NOT modify any files.",
    disallowedTools: ["Write", "Edit", "NotebookEdit"],
  },
  {
    id: "validator",
    name: "Validator",
    description: "Runs the test/lint/typecheck suite and reports failures.",
    systemPrompt:
      "You are a Validator. Run the project's test, typecheck, and lint suites. Capture failures, summarize them with file:line locations, and propose fixes only if asked. Do NOT modify code unless explicitly instructed.",
  },
];

const ROLES_FILE_RELATIVE = ".t3/roles.json";

export interface OrchestratorRolesShape {
  readonly listRoles: Effect.Effect<ReadonlyArray<OrchestratorRole>, never>;
  readonly getRole: (id: string) => Effect.Effect<OrchestratorRole | null, never>;
}

export class OrchestratorRoles extends Context.Service<
  OrchestratorRoles,
  OrchestratorRolesShape
>()("t3/orchestrator/Roles") {}

const makeOrchestratorRoles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const loadOverrides = Effect.gen(function* () {
    const home = NodeOS.homedir();
    const filePath = path.join(home, ROLES_FILE_RELATIVE);
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return [] as ReadonlyArray<OrchestratorRole>;
    const raw = yield* fs.readFileString(filePath).pipe(Effect.option);
    if (raw._tag === "None") return [] as ReadonlyArray<OrchestratorRole>;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw.value) as unknown,
      catch: () => "parse-error",
    }).pipe(Effect.option);
    if (parsed._tag === "None") return [] as ReadonlyArray<OrchestratorRole>;
    const decoded = yield* Schema.decodeUnknownEffect(RolesFileSchema)(parsed.value).pipe(
      Effect.option,
    );
    if (decoded._tag === "None") return [] as ReadonlyArray<OrchestratorRole>;
    return decoded.value.roles;
  });

  const listRoles = Effect.gen(function* () {
    const overrides = yield* loadOverrides;
    if (overrides.length === 0) return BUILTIN_ROLES;
    const overrideById = new Map(overrides.map((role) => [role.id, role]));
    const merged: Array<OrchestratorRole> = [];
    for (const builtin of BUILTIN_ROLES) {
      merged.push(overrideById.get(builtin.id) ?? builtin);
      overrideById.delete(builtin.id);
    }
    for (const remaining of overrideById.values()) merged.push(remaining);
    return merged as ReadonlyArray<OrchestratorRole>;
  });

  const getRole = (id: string) =>
    Effect.map(listRoles, (roles) => roles.find((role) => role.id === id) ?? null);

  return { listRoles, getRole } satisfies OrchestratorRolesShape;
});

export const OrchestratorRolesLive = Layer.effect(OrchestratorRoles, makeOrchestratorRoles);
