import path from "node:path";

const SAVESTATE_DIR = ".savestate";

export function savestateDir(projectRoot: string): string {
  return path.join(projectRoot, SAVESTATE_DIR);
}

export function statesDir(projectRoot: string): string {
  return path.join(savestateDir(projectRoot), "states");
}

export function stateDir(projectRoot: string, name: string): string {
  return path.join(statesDir(projectRoot), name);
}

export function stateJsonPath(projectRoot: string, name: string): string {
  return path.join(stateDir(projectRoot, name), "state.json");
}

export function noteMdPath(projectRoot: string, name: string): string {
  return path.join(stateDir(projectRoot, name), "note.md");
}

export function patchPath(projectRoot: string, name: string): string {
  return path.join(stateDir(projectRoot, name), "git-patch.diff");
}

export function indexPath(projectRoot: string): string {
  return path.join(savestateDir(projectRoot), "index.json");
}

export function lockPath(projectRoot: string): string {
  return path.join(savestateDir(projectRoot), "lock");
}

export function tmpDir(projectRoot: string): string {
  return path.join(savestateDir(projectRoot), "_tmp");
}

export function gitignorePath(projectRoot: string): string {
  return path.join(savestateDir(projectRoot), ".gitignore");
}
