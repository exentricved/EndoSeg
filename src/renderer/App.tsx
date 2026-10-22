import { useCallback, useEffect, useState } from "react";
import { STAGE_LABELS } from "../core/stages.js";
import type { ProjectSummary } from "../core/manifest.js";
import type { AppInfo, LibraryState } from "../shared/ipc.js";
import { StageBar } from "./StageBar.js";
import { CrashLogView } from "./CrashLogView.js";
import { ActivityView } from "./ActivityView.js";
import { SignInView } from "./SignInView.js";
import { SettingsView } from "./SettingsView.js";
import { ProjectDetail } from "./ProjectDetail.js";
import { StageBadge, formatTime } from "./ui.js";
import { SegmentationView } from "./SegmentationView.js";

type View =
  | { kind: "hub" }
  | { kind: "crashlog" }
  | { kind: "activity" }
  | { kind: "settings" }
  | { kind: "project"; id: string }
  | { kind: "annotator"; id: string };

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [library, setLibrary] = useState<LibraryState | null>(null);
  const [view, setView] = useState<View>({ kind: "hub" });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [switchingUser, setSwitchingUser] = useState(false);

  const refresh = useCallback(async () => {
    setLibrary(await window.endoseg.getLibrary());
  }, []);

  const refreshInfo = useCallback(async () => {
    setInfo(await window.endoseg.appInfo());
  }, []);

  useEffect(() => {
    void refreshInfo();
    void refresh();
  }, [refresh, refreshInfo]);

  const submitNew = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    const { id } = await window.endoseg.createProject(name);
    setNewName("");
    setCreating(false);
    await refresh();
    setView({ kind: "project", id });
  }, [newName, refresh]);

  // Nothing is usable until someone has entered their name and the library is writable.
  if (!info) return null;
  if (!info.user || switchingUser) {
    return (
      <div className="app">
        <SignInView
          onSignedIn={(ai) => {
            setInfo(ai);
            setSwitchingUser(false);
            setView({ kind: "hub" });
            void refresh();
          }}
        />
      </div>
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
            {projectId}
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <SegmentationView projectId={projectId} />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            {"👁"}
          </span>
          <span className="brand-name">EndoSeg</span>
          <span className="version">{info ? `v${info.version}` : ""}</span>
          <button
            className="link user-chip"
            title="Recorded on intake, export and status changes — click to switch person"
            onClick={() => setSwitchingUser(true)}
          >
            {info.user} · switch
          </button>
        </div>
        <nav className="nav">
          <button
            className={view.kind === "hub" || view.kind === "project" ? "active" : ""}
            onClick={() => setView({ kind: "hub" })}
          >
            Projects
          </button>
          <button
            className={view.kind === "activity" ? "active" : ""}
            onClick={() => setView({ kind: "activity" })}
          >
            Activity
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
            <div className="library-path" title={library?.baseDir}>
              <span className="muted">Library:</span> {library?.baseDir ?? "…"}
            </div>
            <div className="toolbar-actions">
              <button onClick={() => setCreating(true)}>+ New project</button>
              <button className="secondary" onClick={refresh}>
                Refresh
              </button>
            </div>
          </div>

          {library && !library.writable && (
            <div className="library-error">
              ⚠ {library.error ?? "The library folder can't be used."} Projects can't be opened or saved until it is
              reachable — check the network drive, then Refresh, or pick another folder in Settings.
            </div>
          )}

          {creating && (
            <div className="new-project">
              <input
                autoFocus
                placeholder="Case name (e.g. Case 12 — sphincterotomy)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitNew();
                  if (e.key === "Escape") setCreating(false);
                }}
              />
              <button onClick={() => void submitNew()}>Create</button>
              <button className="secondary" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          )}

          <ProjectTable
            projects={library?.projects ?? []}
            onOpen={(id) => setView({ kind: "project", id })}
          />
        </main>
      )}

      {view.kind === "project" && (
        <ProjectDetail
          id={view.id}
          onBack={() => {
            void refresh();
            setView({ kind: "hub" });
          }}
          onOpenAnnotator={(id) => setView({ kind: "annotator", id })}
        />
      )}

      {view.kind === "settings" && (
        <SettingsView onChanged={() => { void refreshInfo(); void refresh(); }} />
      )}

      {view.kind === "crashlog" && <CrashLogView />}

      {view.kind === "activity" && <ActivityView />}
    </div>
  );
}

function ProjectTable(props: {
  projects: ProjectSummary[];
  onOpen: (id: string) => void;
}) {
  if (props.projects.length === 0) {
    return (
      <div className="empty">
        <p>No projects yet.</p>
        <p className="muted">
          Create one to start the Intake {"→"} Segmentation {"→"} Export pipeline.
        </p>
      </div>
    );
  }
  return (
    <table className="projects">
      <thead>
        <tr>
          <th>Project</th>
          <th>Video</th>
          <th>Status</th>
          <th>Pipeline</th>
          <th>Current stage</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {props.projects.map((p) => (
          <tr
            key={p.id}
            className={`clickable ${p.needsAttention ? "attention" : ""}`}
            onClick={() => props.onOpen(p.id)}
          >
            <td>
              <div className="proj-name">{p.name}</div>
              <div className="proj-id muted">{p.id}</div>
            </td>
            <td>
              {p.work?.sourceFile ? (
                <>
                  <div title={p.work.sourcePath}>{p.work.sourceFile}</div>
                  <div className="proj-id muted">by {p.work.intakeBy ?? "unknown"}</div>
                </>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
            <td>
              {p.work ? (
                <span className={`work-status work-${p.work.status}`}>{p.work.status}</span>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
            <td>
              <StageBar statuses={p.stageStatuses} />
            </td>
            <td>
              <StageBadge status={p.currentStatus} /> {STAGE_LABELS[p.currentStage]}
            </td>
            <td className="muted">{formatTime(p.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
