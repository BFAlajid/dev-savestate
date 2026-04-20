// Migration registry.
//
// A migration takes a raw parsed JSON object at schema version `N` and
// returns the same object shaped for version `N + 1`. Migrations are pure
// transforms — they must not perform IO or mutate their input.
//
// At v1 (the current and only shipped schema version) the registries are
// intentionally empty. When adding a new schema field that breaks an older
// CLI's ability to read a new file, bump CURRENT_SCHEMA_VERSION in
// schemas.ts and register a v{N}-to-v{N+1} transform here for both state
// and index payloads as applicable.

export type Migration = (raw: any) => any;

// Key is the *from* version. Value transforms raw v{key} → raw v{key+1}.
export const stateMigrations: Record<number, Migration> = {};

export const indexMigrations: Record<number, Migration> = {};

// Example — kept commented out so reviewers can see the expected shape when
// adding the first real migration. Do not uncomment without a corresponding
// bump to CURRENT_SCHEMA_VERSION.
//
// stateMigrations[1] = (raw) => ({
//   ...raw,
//   version: 2,
//   parentStateId: raw.parentStateId ?? null,
// });
