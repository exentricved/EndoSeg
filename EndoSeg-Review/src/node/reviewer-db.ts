// SQLite helpers for reviewer identity (stored in userData) and per-package decisions/edits.
import Database from "better-sqlite3";
import * as path from "node:path";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS reviewer (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    setup_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS frame_decisions (
    frame_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    comment TEXT,
    decided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS edit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    frame_id TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    logged_at TEXT NOT NULL
  );
`;

/** Open (and migrate) the reviewer-settings database stored in userData. */
export function openSettingsDb(userDataPath: string): Database.Database {
  const db = new Database(path.join(userDataPath, "reviewer-settings.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function getReviewerName(userDataPath: string): string | null {
  const db = openSettingsDb(userDataPath);
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'reviewer_name'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

export function setReviewerName(userDataPath: string, name: string): void {
  const db = openSettingsDb(userDataPath);
  db.prepare("INSERT INTO settings(key, value) VALUES('reviewer_name', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(name);
  db.close();
}

// ── Per-package review DB (lives inside the working dir extracted from .endoseg) ──

/** Ensure the review.db inside workingDir is initialized with the correct schema. */
export function ensureReviewDb(workingDir: string, reviewerName: string): void {
  const db = new Database(path.join(workingDir, "review.db"));
  db.exec(SCHEMA);
  const existing = db.prepare("SELECT id FROM reviewer LIMIT 1").get();
  if (!existing) {
    db.prepare("INSERT INTO reviewer (name, setup_at) VALUES (?, ?)")
      .run(reviewerName, new Date().toISOString());
  }
  db.close();
}

export function setFrameDecision(
  workingDir: string,
  frameId: string,
  status: string,
  comment?: string,
): void {
  const db = new Database(path.join(workingDir, "review.db"));
  db.prepare(`
    INSERT INTO frame_decisions (frame_id, status, comment, decided_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(frame_id) DO UPDATE SET
      status = excluded.status,
      comment = excluded.comment,
      decided_at = excluded.decided_at
  `).run(frameId, status, comment ?? null, new Date().toISOString());
  db.close();
}

type FrameStatus = "approved" | "rejected" | "edited" | "pending";

export function getDecisions(workingDir: string): Record<string, { status: FrameStatus; comment?: string }> {
  const db = new Database(path.join(workingDir, "review.db"));
  try {
    const rows = db
      .prepare("SELECT frame_id, status, comment FROM frame_decisions")
      .all() as Array<{ frame_id: string; status: string; comment: string | null }>;
    const result: Record<string, { status: FrameStatus; comment?: string }> = {};
    const valid = new Set<FrameStatus>(["approved", "rejected", "edited", "pending"]);
    for (const r of rows) {
      const s: FrameStatus = valid.has(r.status as FrameStatus) ? (r.status as FrameStatus) : "pending";
      result[r.frame_id] = { status: s, comment: r.comment ?? undefined };
    }
    return result;
  } finally {
    db.close();
  }
}

export function logEdit(workingDir: string, frameId: string, action: string, details?: unknown): void {
  const db = new Database(path.join(workingDir, "review.db"));
  db.prepare("INSERT INTO edit_log (frame_id, action, details, logged_at) VALUES (?, ?, ?, ?)")
    .run(frameId, action, details !== undefined ? JSON.stringify(details) : null, new Date().toISOString());
  db.close();
}
