// Library-wide activity log: who took in which video, who exported, status
// changes. Lives in <library>/activity/<name>.jsonl — one append-only file per
// person (the name entered at start-up), so people sharing a library on a
// network drive never write to the same file. Pure Node so it is unit-testable.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { WorkStatus } from "../core/stages.js";

export type ActivityAction =
  | "intake_started"
  | "intake_completed"
  | "intake_failed"
  | "export_completed"
  | "export_failed"
  | "status_changed"
  | "frames_removed";

export interface ActivityEvent {
  at: string;
  user: string;
  host: string;
  action: ActivityAction;
  projectId: string;
  projectName?: string;
  /** Video file (intake) or export folder (export). */
  file?: string;
  sha256?: string;
  status?: WorkStatus;
  /** Short human-readable extra, e.g. "120 frames" or the error message. */
  detail?: string;
}

/** Who is acting: the name entered at start-up, plus the computer it was entered on. */
export interface Identity {
  user: string;
  host: string;
}

export function activityDir(baseDir: string): string {
  return path.join(baseDir, "activity");
}

function logFile(baseDir: string, user: string): string {
  const safe = user.trim().replace(/[^a-zA-Z0-9._-]+/g, "_") || "unknown";
  return path.join(activityDir(baseDir), `${safe}.jsonl`);
}

/** Append one event to the acting user's log. Never throws — logging must not break work. */
export async function logActivity(
  baseDir: string,
  event: Omit<ActivityEvent, "user" | "host">,
  who: Identity,
): Promise<void> {
  try {
    await fs.mkdir(activityDir(baseDir), { recursive: true });
    const line = JSON.stringify({ ...event, user: who.user, host: who.host }) + "\n";
    await fs.appendFile(logFile(baseDir, who.user), line, "utf8");
  } catch (err) {
    console.error("[activity] could not write log:", err instanceof Error ? err.message : err);
  }
}

function isEvent(v: unknown): v is ActivityEvent {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.at === "string" && typeof e.user === "string" && typeof e.action === "string" && typeof e.projectId === "string";
}

/** Every user's events merged, newest first. Malformed lines are skipped. */
export async function readActivity(baseDir: string, limit = 1000): Promise<ActivityEvent[]> {
  let names: string[];
  try {
    names = (await fs.readdir(activityDir(baseDir))).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const events: ActivityEvent[] = [];
  for (const n of names) {
    let text: string;
    try {
      text = await fs.readFile(path.join(activityDir(baseDir), n), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const v: unknown = JSON.parse(line);
        if (isEvent(v)) events.push(v);
      } catch { /* partial line from an interrupted write */ }
    }
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  return events.slice(0, limit);
}
