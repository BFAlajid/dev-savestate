// Migration registry.
//
// A migration takes a raw parsed JSON object at schema version `N` and
// returns the same object shaped for version `N + 1`. Migrations are pure
// transforms — they must not perform IO or mutate their input.
//
// When adding a new schema field that breaks an older CLI's ability to
// read a new file, bump CURRENT_SCHEMA_VERSION in schemas.ts and register
// a v{N}-to-v{N+1} transform here for both state and index payloads as
// applicable.

export type Migration = (raw: any) => any;

// Key is the *from* version. Value transforms raw v{key} → raw v{key+1}.
export const stateMigrations: Record<number, Migration> = {
  // v1 → v2: added `untracked` manifest for brand-new files. Pre-v2 states
  // were captured with `git diff HEAD` only (tracked files) so there are
  // genuinely zero untracked blobs on disk for them — an empty manifest is
  // the honest upgrade.
  1: (raw) => ({
    ...raw,
    version: 2,
    untracked: { files: [] },
  }),
};

export const indexMigrations: Record<number, Migration> = {
  // v1 → v2: no shape change for the index itself; bumping alongside the
  // state bump so the `version` field stays consistent across files written
  // by a given CLI build. IndexEntry is unaffected.
  1: (raw) => ({ ...raw, version: 2 }),
};
