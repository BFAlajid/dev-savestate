import type { SaveState, IndexEntry } from "./types.js";

export function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(isoDate).toLocaleDateString();
}

export function formatDateShort(isoDate: string): string {
  const d = new Date(isoDate);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const month = months[d.getMonth()];
  const day = d.getDate();
  const hours = d.getHours().toString().padStart(2, "0");
  const mins = d.getMinutes().toString().padStart(2, "0");
  return `${month} ${day}, ${hours}:${mins}`;
}

export function printMentalStack(state: SaveState): void {
  const w = 50;
  const border = "\u2500".repeat(w - 2);
  const empty = "\u2502" + " ".repeat(w - 2) + "\u2502";

  console.log(`\u250C${border}\u2510`);
  console.log(empty);
  printPadded(`  STATE: ${state.name}`, w);
  console.log(empty);
  printPadded(`  Branch     ${state.git.branch}`, w);
  printPadded(
    `  Saved      ${formatRelativeTime(state.updatedAt)} (${formatDateShort(state.updatedAt)})`,
    w
  );

  // Files
  if (state.editor?.openFiles?.length) {
    console.log(empty);
    printPadded("  FILES", w);
    for (const file of state.editor.openFiles) {
      const active =
        file.relativePath === state.editor.activeFile ? "  (active)" : "";
      printPadded(
        `    ${file.relativePath}:${file.cursorLine}${active}`,
        w
      );
    }
  }

  // Note
  if (state.note) {
    console.log(empty);
    printPadded("  NOTE", w);
    const lines = state.note.split("\n");
    for (const line of lines) {
      printPadded(`  ${line}`, w);
    }
  }

  // Next Step
  if (state.nextStep) {
    console.log(empty);
    printPadded("  NEXT STEP", w);
    printPadded(`  ${state.nextStep}`, w);
  }

  console.log(empty);
  console.log(`\u2514${border}\u2518`);
}

function printPadded(text: string, width: number): void {
  const content = text.slice(0, width - 4);
  const padding = Math.max(0, width - 2 - content.length);
  console.log(`\u2502${content}${" ".repeat(padding)}\u2502`);
}

export function printStateList(entries: IndexEntry[]): void {
  if (entries.length === 0) {
    console.log("No save states found.");
    return;
  }

  // Header
  console.log(
    padRight("NAME", 24) +
      padRight("BRANCH", 20) +
      padRight("SAVED", 18) +
      "NOTE"
  );
  console.log("\u2500".repeat(80));

  for (const entry of entries) {
    const line =
      padRight(entry.name, 24) +
      padRight(entry.branch, 20) +
      padRight(formatRelativeTime(entry.updatedAt), 18) +
      entry.notePreview.slice(0, 40);
    console.log(line);
  }

  console.log(`\n${entries.length} state(s)`);
}

function padRight(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len - 1) + " ";
  return str + " ".repeat(len - str.length);
}
