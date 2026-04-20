// Migration runner.
//
// Every JSON read on the critical path goes through one of these functions.
// They decide:
//   1. What version the raw payload is (undefined → treat as v0).
//   2. Whether to apply zero or more forward migrations from the registry.
//   3. Whether the final payload validates against the current schema.
//
// If the payload is from a *newer* CLI (version > CURRENT_SCHEMA_VERSION)
// we refuse loudly — silently truncating unknown fields would be worse than
// a clear "upgrade dvs" message.

import { z } from "zod";
import {
  CURRENT_SCHEMA_VERSION,
  SaveStateSchema,
  IndexFileSchema,
  type ValidatedSaveState,
  type ValidatedIndexFile,
} from "../schemas.js";
import {
  stateMigrations,
  indexMigrations,
  type Migration,
} from "./registry.js";

export class SchemaVersionError extends Error {
  constructor(
    public readonly fromVersion: number,
    public readonly currentVersion: number,
    what: string
  ) {
    super(
      `${what} was written by a newer dvs CLI (schema v${fromVersion}; this CLI understands v${currentVersion}). ` +
        `Upgrade with: npm i -g dev-savestate@latest`
    );
    this.name = "SchemaVersionError";
  }
}

export class SchemaValidationError extends Error {
  constructor(
    what: string,
    public readonly zodError: z.ZodError
  ) {
    // z.prettifyError is only in v4; format the issues ourselves so we work
    // on v3.x as declared in package.json.
    const issues = zodError.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    super(`${what} failed schema validation:\n${issues}`);
    this.name = "SchemaValidationError";
  }
}

// Read a raw JSON object's version field, defaulting to 0 if absent/invalid.
// v0 is the pre-versioning sentinel; no payloads at v0 exist in the wild
// (v1 was the first shipped schema) but we accept them as a graceful fallback.
function readVersion(raw: unknown): number {
  if (raw && typeof raw === "object" && "version" in raw) {
    const v = (raw as { version: unknown }).version;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

// Walk the registry from `from` up to CURRENT_SCHEMA_VERSION, applying each
// migration in order. Throws if a required transform is missing (i.e. the
// registry has a gap). Returns the raw upgraded payload; validation is the
// caller's responsibility.
function applyMigrations(
  registry: Record<number, Migration>,
  from: number,
  raw: unknown,
  what: string
): unknown {
  let current = raw;
  for (let v = from; v < CURRENT_SCHEMA_VERSION; v++) {
    const step = registry[v];
    if (!step) {
      throw new Error(
        `No migration registered for ${what} v${v} → v${v + 1}. ` +
          `This is a CLI bug — please report.`
      );
    }
    current = step(current);
  }
  return current;
}

/**
 * Validate + (future-proof) migrate a raw state.json payload.
 *
 * - undefined / missing version → treated as v0 and run through the pipeline.
 * - version === CURRENT → validated directly.
 * - version < CURRENT → each registered v{N}-to-v{N+1} is applied in order,
 *   then validated against the current schema.
 * - version > CURRENT → throws SchemaVersionError.
 *
 * Throws SchemaValidationError on any validation failure.
 */
export function migrateState(raw: unknown): ValidatedSaveState {
  const from = readVersion(raw);
  if (from > CURRENT_SCHEMA_VERSION) {
    throw new SchemaVersionError(from, CURRENT_SCHEMA_VERSION, "state.json");
  }
  const upgraded = applyMigrations(stateMigrations, from, raw, "state");
  const result = SaveStateSchema.safeParse(upgraded);
  if (!result.success) {
    throw new SchemaValidationError("state.json", result.error);
  }
  return result.data;
}

/**
 * Same as migrateState but for index.json.
 */
export function migrateIndex(raw: unknown): ValidatedIndexFile {
  const from = readVersion(raw);
  if (from > CURRENT_SCHEMA_VERSION) {
    throw new SchemaVersionError(from, CURRENT_SCHEMA_VERSION, "index.json");
  }
  const upgraded = applyMigrations(indexMigrations, from, raw, "index");
  const result = IndexFileSchema.safeParse(upgraded);
  if (!result.success) {
    throw new SchemaValidationError("index.json", result.error);
  }
  return result.data;
}
