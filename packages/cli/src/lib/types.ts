export interface SaveState {
  version: 2;
  name: string;
  createdAt: string;
  updatedAt: string;
  projectRoot: string;

  note: string;
  nextStep?: string;
  tags: string[];

  git: {
    branch: string;
    commitHash: string;
    hasUncommittedChanges: boolean;
    patchFile: string;
    patchHash: string;
  };

  editor?: {
    openFiles: Array<{
      relativePath: string;
      cursorLine: number;
      cursorColumn: number;
      viewColumn: number;
    }>;
    activeFile?: string;
  };

  processes: Array<{
    name: string;
    command: string;
    args: string[];
    cwd: string;
    port?: number;
    source: "dvs-run" | "config";
  }>;

  /**
   * Manifest of brand-new (not-yet-`git add`ed) files captured alongside the
   * git patch. Blob bytes live at <stateDir>/untracked/<relativePath>.
   * Added in schema v2. v1 payloads are migrated forward with `{ files: [] }`.
   */
  untracked: {
    files: Array<{
      relativePath: string;
      size: number;
      mode: number;
    }>;
  };

  archived: boolean;
  lastLoadedAt?: string;
  loadCount: number;
}

export interface IndexFile {
  version: 2;
  states: IndexEntry[];
}

export interface IndexEntry {
  name: string;
  createdAt: string;
  updatedAt: string;
  branch: string;
  notePreview: string;
  archived: boolean;
  tags?: string[];
}

export interface ProjectConfig {
  processes?: {
    commands?: Array<{
      name: string;
      command: string;
      cwd?: string;
      port?: number;
    }>;
  };
  promptNextStep?: boolean;
}
