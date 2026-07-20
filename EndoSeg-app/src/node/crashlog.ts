// Crash / error logging. Writes human-readable incident reports a non-technical
// user can open, read, and copy/paste for troubleshooting (EndoSeg.md §7).
// PHI-free by contract: callers must not pass patient identifiers or pixel data.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface CrashContext {
  /** e.g. "uncaughtException", "render-process-gone", "python:segment" */
  source: string;
  /** Short human summary of what happened. */
  message: string;
  /** Stack trace or stderr tail, if any. */
  detail?: string;
  /** Which project/stage was active (ids only, never patient data). */
  projectId?: string;
  stage?: string;
}

export interface CrashEnv {
  appVersion: string;
  os: string;
  electron?: string;
}

export interface CrashIncident extends CrashContext {
  id: string;
  timestamp: string;
}

export function formatIncident(
  inc: CrashIncident,
  env: CrashEnv,
): string {
  const lines = [
    "===== EndoSeg crash report =====",
    `Time:        ${inc.timestamp}`,
    `Incident:    ${inc.id}`,
    `App version: ${env.appVersion}`,
    `OS:          ${env.os}`,
    env.electron ? `Electron:    ${env.electron}` : null,
    `Source:      ${inc.source}`,
    inc.projectId ? `Project:     ${inc.projectId}` : null,
    inc.stage ? `Stage:       ${inc.stage}` : null,
    "",
    "Message:",
    inc.message,
    "",
    inc.detail ? "Detail:" : null,
    inc.detail ?? null,
    "================================",
    "",
  ];
  return lines.filter((l) => l !== null).join("\n");
}

export class CrashLogger {
  private readonly dir: string;
  private readonly env: CrashEnv;
  private seq = 0;

  constructor(logsDir: string, env: CrashEnv) {
    this.dir = logsDir;
    this.env = env;
  }

  /** Deterministic-ish incident id without relying on Date.now/random. */
  private nextId(timestamp: string): string {
    this.seq += 1;
    const stamp = timestamp.replace(/[:.]/g, "-");
    return `crash-${stamp}-${this.seq}`;
  }

  /** Record an incident: append to rolling log + write a per-incident file. */
  async record(ctx: CrashContext, timestamp: string): Promise<CrashIncident> {
    const incident: CrashIncident = {
      ...ctx,
      id: this.nextId(timestamp),
      timestamp,
    };
    const text = formatIncident(incident, this.env);
    await fs.mkdir(path.join(this.dir, "crash"), { recursive: true });
    await fs.appendFile(path.join(this.dir, "endoseg.log"), text, "utf8");
    await fs.writeFile(path.join(this.dir, "crash", `${incident.id}.txt`), text, "utf8");
    return incident;
  }

  /** List incident files, newest first. */
  async list(): Promise<string[]> {
    try {
      const files = await fs.readdir(path.join(this.dir, "crash"));
      return files.filter((f) => f.endsWith(".txt")).sort().reverse();
    } catch {
      return [];
    }
  }

  /** Full text of one incident, for the in-app viewer / copy button. */
  async read(file: string): Promise<string | null> {
    // Guard against path traversal: only allow plain incident filenames.
    if (file.includes("/") || file.includes("\\") || file.includes("..")) return null;
    try {
      return await fs.readFile(path.join(this.dir, "crash", file), "utf8");
    } catch {
      return null;
    }
  }

  get directory(): string {
    return this.dir;
  }
}
