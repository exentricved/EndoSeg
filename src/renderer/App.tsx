import { useCallback, useEffect, useState } from "react";
import { STAGE_LABELS, type ProjectManifest } from "../core/stages.js";
import type { ProjectSummary } from "../core/manifest.js";
import type { AppInfo, WorkspacesState } from "../shared/ipc.js";
import {
  WORKSPACE_LABELS,
  makeRef,
  parseRef,
  rawRowStatus,
  formatBytes,
  intakeStatusOf,
  type RawRow,
  type WorkspaceId,
} from "../core/workspaces.js";
import { StageBar } from "./StageBar.js";
import { CrashLogView } from "./CrashLogView.js";
import { SettingsView } from "./SettingsView.js";
import { ProjectDetail } from "./ProjectDetail.js";
import { StageBadge, formatTime, errorText } from "./ui.js";
import { SegmentationView } from "./SegmentationView.js";
import { PhasesView } from "./PhasesView.js";
import { CropView } from "./CropView.js";

type Tab = "raw" | WorkspaceId;

/** Projects are addressed by "<ws>:<case>" refs (see core/workspaces). */
type View =
  | { kind: "hub" }
  | { kind: "crashlog" }
  | { kind: "settings" }
  /** `intakePath`: a Raw video that intake should start on right away. */
  | { kind: "project"; id: string; intakePath?: string }
  | { kind: "phases"; id: string; manifest: ProjectManifest | null }
  | { kind: "crop"; id: string }
  | { kind: "annotator"; id: string };

/** "Annotated 1 · <case>" for a "<ws>:<case>" ref. */
function refLabel(ref: string): string {
  const r = parseRef(ref);
  return r ? `${WORKSPACE_LABELS[r.ws]} · ${r.id}` : ref;
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [ws, setWs] = useState<WorkspacesState | null>(null);
  const [view, setView] = useState<View>({ kind: "hub" });
  const [tab, setTab] = useState<Tab>("raw");
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Set when another computer took over the case open here: { ref, message }.
  const [lockLost, setLockLost] = useState<{ ref: string; text: string } | null>(null);

  // A case's lock is held while any of its views is showing; release it on the
  // way back to the Cases, Settings or Troubleshooting screens.
  const openRef = view.kind === "project" || view.kind === "phases" || view.kind === "crop" || view.kind === "annotator" ? view.id : null;
  useEffect(() => {
    if (!openRef) {
      setLockLost(null);
      void window.endoseg.closeCase();
    }
  }, [openRef]);
  useEffect(
    () =>
      window.endoseg.onCaseAccessChanged((c) =>
        setLockLost((cur) =>
          c.access.readOnly
            ? { ref: c.ref, text: `${c.access.lockedBy ?? "Someone else"} took over ${refLabel(c.ref)}. Changes you make now won't be saved; go back to the case page.` }
            : cur?.ref === c.ref
            ? null // the case is ours again
            : cur,
        ),
      ),
    [],
  );
  const lostToast = lockLost && lockLost.ref === openRef ? (
    <div className="lock-lost" role="alert">
      🔒 {lockLost.text}
    </div>
  ) : null;

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setWs(await window.endoseg.getWorkspaces());
    } finally {
      setRefreshing(false);
    }
  }, []);

  const refreshInfo = useCallback(async () => {
    setInfo(await window.endoseg.appInfo());
  }, []);

  useEffect(() => {
    void refreshInfo();
    void refresh();
  }, [refresh, refreshInfo]);

  /** Raw → Start intake: claim the case in Annotated 1, then intake runs on the project page. */
  const startIntake = useCallback(
    async (videoPath: string) => {
      setNotice(null);
      const r = await window.endoseg.startFromRaw(videoPath);
      if (!r.ok || !r.ref) {
        setNotice(r.error ?? "Could not start intake.");
        await refresh();
        return;
      }
      setView({ kind: "project", id: r.ref, intakePath: videoPath });
    },
    [refresh],
  );

  /** Back to the hub, on the tab the project belongs to. */
  const backToHub = useCallback(
    (ref?: string) => {
      const w = ref ? parseRef(ref)?.ws : undefined;
      if (w) setTab(w);
      void refresh();
      setView({ kind: "hub" });
    },
    [refresh],
  );

  if (!info) return null;

  if (view.kind === "crop") {
    const projectId = view.id;
    return (
      <>
        {lostToast}
        <CropView projectId={projectId} onDone={() => { void refresh(); setView({ kind: "project", id: projectId }); }} />
      </>
    );
  }

  if (view.kind === "phases") {
    const projectId = view.id;
    return (
      <>
      {lostToast}
      <PhasesView
        projectId={projectId}
        manifest={view.manifest}
        onBack={() => { void refresh(); setView({ kind: "project", id: projectId }); }}
        onExported={(m) => setView({ kind: "phases", id: projectId, manifest: m })}
      />
      </>
    );
  }

  // Annotator runs as a full-window view with its own toolbar/sidebar.
  // EndoSeg adds only a thin back bar above it.
  if (view.kind === "annotator") {
    const projectId = view.id;
    const goBack = () => {
      void refresh();
      setView({ kind: "project", id: projectId });
    };
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          background: "#0d1520",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "6px 12px",
            borderBottom: "1px solid #1e2d40",
            color: "#e4e9f0",
            flexShrink: 0,
          }}
        >
          <button className="secondary" onClick={goBack}>
            {"←"} Back to project
          </button>
          <strong>Annotator</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            {refLabel(projectId)}
          </span>
        </div>
        {lostToast}
        <div style={{ flex: 1, minHeight: 0 }}>
          <SegmentationView projectId={projectId} />
        </div>
      </div>
    );
  }

  const tabFolder = ws ? (tab === "raw" ? ws.folders.raw : ws.folders[tab]) : "…";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            {"👁"}
          </span>
          <span className="brand-name">EndoSeg</span>
          <span className="version">{info ? `v${info.version}` : ""}</span>
        </div>
        <nav className="nav">
          <button
            className={view.kind === "hub" || view.kind === "project" ? "active" : ""}
            onClick={() => setView({ kind: "hub" })}
          >
            Cases
          </button>
          <button
            className={view.kind === "settings" ? "active" : ""}
            onClick={() => setView({ kind: "settings" })}
          >
            Settings
          </button>
          <button
            className={view.kind === "crashlog" ? "active" : ""}
            onClick={() => setView({ kind: "crashlog" })}
          >
            Troubleshooting
          </button>
        </nav>
      </header>

      {view.kind === "hub" && (
        <main className="hub">
          <div className="hub-toolbar">
            <div className="tabs" role="tablist">
              {(["raw", "a1", "a2"] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  className={tab === t ? "tab active" : "tab"}
                  onClick={() => setTab(t)}
                >
                  {t === "raw" ? "Raw" : WORKSPACE_LABELS[t]}
                  <span className="tab-count">{ws ? (t === "raw" ? ws.raw.length : ws[t].length) : "…"}</span>
                </button>
              ))}
            </div>
            <div className="toolbar-actions">
              <span className="library-path muted" title={tabFolder}>
                {tabFolder}
              </span>
              <button className="secondary" onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>

          {ws && !ws.writable && (
            <div className="library-error">
              ⚠ {ws.error ?? "The NAS folder can't be used."} Nothing can be opened or saved until it is reachable.
              Check the network drive, then Refresh, or set the NAS folder in Settings.
            </div>
          )}
          {ws?.writable && !ws.rawFound && tab === "raw" && (
            <div className="library-error">
              ⚠ There is no “Raw ERCP Videos” folder in {ws.nasRoot}. Check the NAS folder in Settings.
            </div>
          )}
          {notice && (
            <div className="library-error" role="status">
              {notice}{" "}
              <button className="link" onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </div>
          )}

          {tab === "raw" ? (
            <RawTable
              rows={ws?.raw ?? []}
              disabled={!ws?.writable}
              onStart={(v) => void startIntake(v)}
              onRetry={(row, v) => setView({ kind: "project", id: makeRef("a1", row.caseId), intakePath: v })}
              onOpen={(row) => setView({ kind: "project", id: makeRef(row.inA2 ? "a2" : "a1", row.caseId) })}
            />
          ) : (
            <ProjectTable
              ws={tab}
              projects={ws?.[tab] ?? []}
              inReview={tab === "a1" ? ws?.a1InReview ?? [] : []}
              openBy={ws?.openBy ?? {}}
              disabled={!ws?.writable}
              onOpen={(ref) => setView({ kind: "project", id: ref })}
              onChanged={() => void refresh()}
              onNotice={setNotice}
            />
          )}
        </main>
      )}

      {view.kind === "project" && (
        <ProjectDetail
          key={view.id}
          id={view.id}
          intakePath={view.intakePath}
          onBack={() => backToHub(view.id)}
          onOpenAnnotator={(id) => setView({ kind: "annotator", id })}
          onOpenPhases={(id, manifest) => setView({ kind: "phases", id, manifest })}
          onOpenCrop={(id) => setView({ kind: "crop", id })}
          onOpenCase={(id) => setView({ kind: "project", id })}
        />
      )}

      {view.kind === "settings" && (
        <SettingsView onChanged={() => { void refreshInfo(); void refresh(); }} />
      )}

      {view.kind === "crashlog" && <CrashLogView />}
    </div>
  );
}

function RawTable(props: {
  rows: RawRow[];
  disabled: boolean;
  onStart: (videoPath: string) => void;
  onRetry: (row: RawRow, videoPath: string) => void;
  onOpen: (row: RawRow) => void;
}) {
  const [filter, setFilter] = useState("");
  const [onlyNew, setOnlyNew] = useState(false);
  // Chosen video per case, for the rare folder holding more than one.
  const [picked, setPicked] = useState<Record<string, string>>({});
  // Two-step start: the first click arms the row, the second copies the video.
  const [confirming, setConfirming] = useState<string | null>(null);

  const q = filter.trim().toLowerCase();
  const rows = props.rows.filter(
    (r) => (!q || r.name.toLowerCase().includes(q)) && (!onlyNew || (!r.a1 && !r.inA2)),
  );
  const notStarted = props.rows.filter((r) => !r.a1 && !r.inA2 && r.videos.length).length;

  return (
    <>
      <div className="raw-filters">
        <input
          type="search"
          placeholder="Filter cases…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter cases"
        />
        <label className="muted">
          <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> Only cases not
          started
        </label>
        <span className="muted">
          {notStarted} not started · {props.rows.length} in Raw
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <p>{props.rows.length === 0 ? "No cases in the Raw ERCP Videos folder." : "No cases match."}</p>
        </div>
      ) : (
        <table className="projects">
          <thead>
            <tr>
              <th>Case</th>
              <th>Video</th>
              <th>Size</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const video = r.videos.find((v) => v.path === picked[r.name]) ?? r.videos[0];
              const started = !!r.a1 || r.inA2;
              const intakeUnfinished = !r.inA2 && !!r.a1 && r.a1.intakeStatus !== "done";
              return (
                <tr key={r.name} className={started ? "raw-started" : ""}>
                  <td>
                    <div className="proj-name">{r.name}</div>
                  </td>
                  <td>
                    {r.videos.length > 1 && !started ? (
                      <select
                        value={video?.path}
                        onChange={(e) => setPicked({ ...picked, [r.name]: e.target.value })}
                        aria-label="Video to take in"
                      >
                        {r.videos.map((v) => (
                          <option key={v.path} value={v.path}>
                            {v.file}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted">{video?.file ?? "—"}</span>
                    )}
                  </td>
                  <td className="muted">{formatBytes(video?.bytes ?? 0)}</td>
                  <td>
                    <span className={`raw-status${started ? (intakeUnfinished ? " warn" : " on") : ""}`}>
                      {rawRowStatus(r)}
                    </span>
                  </td>
                  <td>
                    {!started && video ? (
                      confirming === r.name ? (
                        <div className="delete-confirm">
                          <button
                            onClick={() => {
                              setConfirming(null);
                              props.onStart(video.path);
                            }}
                            disabled={props.disabled}
                          >
                            Copy {formatBytes(video.bytes)} to Annotated 1
                          </button>
                          <button className="secondary" onClick={() => setConfirming(null)}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirming(r.name)} disabled={props.disabled}>
                          Start intake
                        </button>
                      )
                    ) : started ? (
                      <div className="delete-confirm">
                        {intakeUnfinished && video && (
                          <button onClick={() => props.onRetry(r, video.path)} disabled={props.disabled}>
                            Retry intake
                          </button>
                        )}
                        <button className="secondary" onClick={() => props.onOpen(r)} disabled={props.disabled}>
                          Open
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function ProjectTable(props: {
  ws: WorkspaceId;
  projects: ProjectSummary[];
  /** Annotated 1 cases already copied to Annotated 2. */
  inReview: string[];
  /** ref → who has it open on another computer. */
  openBy: Record<string, string>;
  disabled: boolean;
  onOpen: (ref: string) => void;
  onChanged: () => void;
  onNotice: (msg: string | null) => void;
}) {
  // Two-step second review: the first click arms the row, the second copies the case.
  const [reviewArmed, setReviewArmed] = useState<string | null>(null);
  const [copying, setCopying] = useState<{ id: string; line: string } | null>(null);
  const review = async (id: string) => {
    setReviewArmed(null);
    props.onNotice(null);
    setCopying({ id, line: "Copying 0%…" });
    const off = window.endoseg.onReviewProgress((p) =>
      setCopying({ id, line: `${p.phase === "copy" ? "Copying" : "Checking copy"} ${p.percent}%…` }),
    );
    try {
      const r = await window.endoseg.startSecondReview(makeRef("a1", id)).catch((err: unknown) => ({ ok: false, error: errorText(err), ref: undefined }));
      if (r.ok && r.ref) props.onOpen(r.ref);
      else {
        props.onNotice(r.error ?? "Could not start the second review.");
        props.onChanged();
      }
    } finally {
      off();
      setCopying(null);
    }
  };
  // Two-step delete: the first click arms the row, the second moves the case to _deleted/.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const remove = async (id: string) => {
    setDeleting(true);
    try {
      await window.endoseg.deleteProject(makeRef(props.ws, id));
    } catch (err) {
      props.onNotice(`Not deleted: ${errorText(err)}`);
    } finally {
      setConfirming(null);
      props.onChanged();
      setDeleting(false);
    }
  };

  if (props.projects.length === 0) {
    return (
      <div className="empty">
        <p>No cases in {WORKSPACE_LABELS[props.ws]} yet.</p>
        <p className="muted">
          {props.ws === "a1"
            ? "Start intake on a case in the Raw tab to bring it here."
            : "Cases come here when someone starts the second review from Annotated 1."}
        </p>
      </div>
    );
  }
  return (
    <table className="projects">
      <thead>
        <tr>
          <th>Case</th>
          <th>Pipeline</th>
          <th>Current stage</th>
          <th>Updated</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {props.projects.map((p) => (
          <tr
            key={p.id}
            className={`clickable ${p.needsAttention ? "attention" : ""}`}
            onClick={() => !copying && props.onOpen(makeRef(props.ws, p.id))}
          >
            <td>
              <div className="proj-name">{p.name}</div>
              {props.openBy[makeRef(props.ws, p.id)] && (
                <div className="open-by" title="Others see this case read-only until it is closed">
                  🔒 Open on {props.openBy[makeRef(props.ws, p.id)]}
                </div>
              )}
            </td>
            <td>
              <StageBar statuses={p.stageStatuses} />
            </td>
            <td>
              <StageBadge status={p.currentStatus} /> {STAGE_LABELS[p.currentStage]}
            </td>
            <td className="muted">{formatTime(p.updatedAt)}</td>
            <td onClick={(e) => e.stopPropagation()}>
              {props.inReview.includes(p.id) ? (
                <div className="delete-confirm">
                  <span className="raw-status on" title="Read-only here: the case is being reviewed in Annotated 2">
                    🔒 In Annotated 2
                  </span>
                  <button className="secondary" onClick={() => props.onOpen(makeRef("a2", p.id))} disabled={props.disabled}>
                    Open review copy
                  </button>
                </div>
              ) : copying?.id === p.id ? (
                <span className="intake-progress">{copying.line}</span>
              ) : reviewArmed === p.id ? (
                <div className="delete-confirm">
                  <button onClick={() => void review(p.id)} disabled={props.disabled || !!copying}>
                    Copy to Annotated 2
                  </button>
                  <button className="secondary" onClick={() => setReviewArmed(null)}>
                    Cancel
                  </button>
                </div>
              ) : confirming === p.id ? (
                <div className="delete-confirm">
                  <button className="danger" onClick={() => void remove(p.id)} disabled={deleting}>
                    Delete
                  </button>
                  <button className="secondary" onClick={() => setConfirming(null)} disabled={deleting}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="delete-confirm">
                  {props.ws === "a1" && (
                    <button
                      onClick={() => setReviewArmed(p.id)}
                      disabled={props.disabled || !!copying || intakeStatusOf(p) !== "done" || !!props.openBy[makeRef("a1", p.id)]}
                      title={
                        props.openBy[makeRef("a1", p.id)]
                          ? "Someone has this case open; it can be sent to review once they close it"
                          : intakeStatusOf(p) === "done"
                          ? "Copy the whole case to Annotated 2 for the second reader; this copy becomes read-only"
                          : "Finish intake first"
                      }
                    >
                      Second review
                    </button>
                  )}
                  <button
                    className="secondary"
                    title="Remove from the list (moved to this folder's _deleted subfolder, so it can be restored)"
                    onClick={() => setConfirming(p.id)}
                    disabled={!!copying || !!props.openBy[makeRef(props.ws, p.id)]}
                  >
                    Delete…
                  </button>
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
