import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActivityAction, ActivityEvent } from "../node/activity.js";
import { formatTime } from "./ui.js";

const ACTION_LABEL: Record<ActivityAction, string> = {
  intake_started: "Intake started",
  intake_completed: "Intake complete",
  intake_failed: "Intake failed",
  export_completed: "Exported",
  export_failed: "Export failed",
  status_changed: "Status changed",
  frames_removed: "Frames removed",
};

function csvCell(v: string | undefined): string {
  const s = v ?? "";
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Library-wide audit trail: who took in which video, exports, status changes.
export function ActivityView() {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [userFilter, setUserFilter] = useState("");
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    setEvents(await window.endoseg.listActivity());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const users = useMemo(() => [...new Set((events ?? []).map((e) => e.user))].sort(), [events]);
  const shown = useMemo(
    () => (events ?? []).filter((e) => !userFilter || e.user === userFilter),
    [events, userFilter],
  );

  const copyCsv = useCallback(async () => {
    const head = "time,user,computer,action,project,file,status,sha256,detail";
    const rows = shown.map((e) =>
      [e.at, e.user, e.host, ACTION_LABEL[e.action] ?? e.action, e.projectName ?? e.projectId, e.file, e.status, e.sha256, e.detail]
        .map(csvCell)
        .join(","),
    );
    await navigator.clipboard.writeText([head, ...rows].join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [shown]);

  return (
    <main className="hub">
      <div className="hub-toolbar">
        <h2 style={{ margin: 0 }}>Activity</h2>
        <div className="toolbar-actions">
          <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)}>
            <option value="">All users</option>
            {users.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
          <button className="secondary" onClick={() => void copyCsv()} disabled={!shown.length}>
            {copied ? "Copied" : "Copy as CSV"}
          </button>
          <button className="secondary" onClick={() => void window.endoseg.openActivityFolder()}>
            Open log folder
          </button>
          <button className="secondary" onClick={() => void reload()}>Refresh</button>
        </div>
      </div>

      {events === null ? (
        <p className="muted">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="empty">
          <p>No activity yet.</p>
          <p className="muted">Intakes, exports and status changes by everyone using this library appear here.</p>
        </div>
      ) : (
        <table className="projects">
          <thead>
            <tr>
              <th>Time</th>
              <th>User</th>
              <th>Action</th>
              <th>Project</th>
              <th>File</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e, i) => (
              <tr key={`${e.at}-${e.user}-${i}`}>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>{formatTime(e.at)}</td>
                <td title={e.host}>{e.user}</td>
                <td>
                  {ACTION_LABEL[e.action] ?? e.action}
                  {e.status && <> → <span className={`work-status work-${e.status}`}>{e.status}</span></>}
                </td>
                <td>{e.projectName ?? e.projectId}</td>
                <td className="muted" style={{ wordBreak: "break-all" }} title={e.sha256 ? `sha256 ${e.sha256}` : undefined}>
                  {e.file ?? "—"}
                </td>
                <td className="muted">{e.detail ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
