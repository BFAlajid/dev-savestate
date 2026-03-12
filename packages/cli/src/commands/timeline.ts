import { Command } from "commander";
import { findProjectRoot } from "../lib/git.js";
import { ensureSavestateDir, readIndex, readState } from "../lib/storage.js";

interface TimelineEvent {
  name: string;
  action: string;
  timestamp: string;
  note?: string;
}

export const timelineCommand = new Command("timeline")
  .description("Show context switch timeline")
  .option("--today", "Show only today's entries")
  .option("--week", "Show only this week's entries")
  .option("--json", "Output as JSON")
  .action(async (opts: { today?: boolean; week?: boolean; json?: boolean }) => {
    try {
      const projectRoot = await findProjectRoot(process.cwd());
      await ensureSavestateDir(projectRoot);
      const index = await readIndex(projectRoot);

      const events: TimelineEvent[] = [];

      for (const entry of index.states) {
        try {
          const state = await readState(projectRoot, entry.name);
          events.push({ name: state.name, action: "save", timestamp: state.createdAt, note: state.note?.slice(0, 50) });
          if (state.lastLoadedAt) {
            events.push({ name: state.name, action: "load", timestamp: state.lastLoadedAt });
          }
          if (state.updatedAt !== state.createdAt) {
            events.push({ name: state.name, action: "update", timestamp: state.updatedAt });
          }
        } catch {}
      }

      const now = new Date();
      let filtered = events;
      if (opts.today) {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        filtered = events.filter((e) => new Date(e.timestamp) >= start);
      } else if (opts.week) {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        filtered = events.filter((e) => new Date(e.timestamp) >= weekAgo);
      }

      filtered.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      if (opts.json) { console.log(JSON.stringify(filtered, null, 2)); return; }
      if (filtered.length === 0) { console.log("No timeline events found."); return; }

      const groups = new Map<string, TimelineEvent[]>();
      for (const event of filtered) {
        const d = new Date(event.timestamp);
        const dateKey = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
        if (!groups.has(dateKey)) groups.set(dateKey, []);
        groups.get(dateKey)!.push(event);
      }

      for (const [date, dayEvents] of groups) {
        console.log(`\n${date}\n`);
        for (const event of dayEvents) {
          const time = new Date(event.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
          const symbol = event.action === "save" ? "●" : event.action === "load" ? "◄" : "↻";
          const note = event.note ? `  "${event.note}"` : "";
          console.log(`  ${time}  ${symbol} ${event.name}${note}`);
        }
      }
      console.log(`\n${filtered.length} event(s)`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });
