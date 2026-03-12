export const COMMANDS = {
  save: "dvs.save",
  quickSave: "dvs.quickSave",
  load: "dvs.load",
  delete: "dvs.delete",
  inspect: "dvs.inspect",
  back: "dvs.back",
  archive: "dvs.archive",
  unarchive: "dvs.unarchive",
  refresh: "dvs.refresh",
} as const;

export const VIEWS = {
  savestateView: "dvs.savestateView",
} as const;

export const CONFIG = {
  cliPath: "devSavestate.cliPath",
  confirmEditorClose: "devSavestate.confirmEditorClose",
  showArchived: "devSavestate.showArchivedStates",
} as const;

export const SAVESTATE_DIR = ".savestate";
export const INDEX_FILE = "index.json";
export const ACTIVE_FILE = "_active.json";
export const STATES_DIR = "states";
