import { useCallback, useEffect, useState } from "react";
import { STAGE_LABELS, type ProjectManifest } from "../core/stages.js";
import { caseNameFromSource } from "../core/phases.js";
import type { ProjectSummary } from "../core/manifest.js";
import type { AppInfo, LibraryState } from "../shared/ipc.js";
import { StageBar } from "./StageBar.js";
import { CrashLogView } from "./CrashLogView.js";
import { SettingsView } from "./SettingsView.js";
import { ProjectDetail } from "./ProjectDetail.js";
import { StageBadge, formatTime } from "./ui.js";
import { SegmentationView } from "./SegmentationView.js";
import { PhasesView } from "./PhasesView.js";
import { CropView } from "./CropView.js";

type View =
  | { kind: "hub" }
  | { kind: "crashlog" }
  | { kind: "settings" }
  /** `intakePath`: a video picked from "New project" that intake should start on right away. */
  | { kind: "project"; id: string; intakePath?: string }
  | { kind: "phases"; id: string; manifest: ProjectManifest | null }
  | { kind: "crop"; id: string }
  | { kind: "annotator"; id: string };

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [library, setLibrary] = useState<LibraryState | null>(null);
  const [view, setView] = useState<View>({ kind: "hub" });

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

  /** New project = pick a video; the project is named after the case folder it sits in. */
  const newFromVideo = useCallback(async () => {
    const sourcePath = await window.endoseg.pickVideo();
    if (!sourcePath) return;
    const { id } = await window.endoseg.createProject(caseNameFromSource(sourcePath));
    await refresh();
    setView({ kind: "project", id, intakePath: sourcePath });
  }, [refresh]);

  if (!info) return null;

  if (view.kind === "crop") {
    const projectId = view.id;
    return <CropView projectId={projectId} onDone={() => { void refresh(); setView({ kind: "project", id: projectId }); }} />;
  }

  if (view.kind === "phases") {
    const projectId = view.id;
    return (
      <PhasesView
        projectId={projectId}
        manifest={view.manifest}
        onBack={() => { void refresh(); setView({ kind: "project", id: projectId }); }}
        onExported={(m) => setView({ kind: "phases", id: projectId, manifest: m })}
      />
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
        </div>
        <nav className="nav">
          <button
            className={view.kind === "hub" || view.kind === "project" ? "active" : ""}
            onClick={() => setView({ kind: "hub" })}
          >
            Projects
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
              <button onClick={() => void newFromVideo()} disabled={library ? !library.writable : true}>
                + New project from video…
              </button>
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

          <ProjectTable
            projects={library?.projects ?? []}
            onOpen={(id) => setView({ kind: "project", id })}
            onDeleted={() => void refresh()}
          />
        </main>
      )}

      {view.kind === "project" && (
        <ProjectDetail
          key={view.id}
          id={view.id}
          intakePath={view.intakePath}
          onBack={() => {
            void refresh();
            setView({ kind: "hub" });
          }}
          onOpenAnnotator={(id) => setView({ kind: "annotator", id })}
          onOpenPhases={(id, manifest) => setView({ kind: "phases", id, manifest })}
          onOpenCrop={(id) => setView({ kind: "crop", id })}
        />
      )}

      {view.kind === "settings" && (
        <SettingsView onChanged={() => { void refreshInfo(); void refresh(); }} />
      )}

      {view.kind === "crashlog" && <CrashLogView />}
    </div>
  );
}

function ProjectTable(props: {
  projects: ProjectSummary[];
  onOpen: (id: string) => void;
  onDeleted: () => void;
}) {
  // Two-step delete: the first click arms the row, the second moves the project to deleted/.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const remove = async (id: string) => {
    setDeleting(true);
    try {
      await window.endoseg.deleteProject(id);
      setConfirming(null);
      props.onDeleted();
    } finally {
      setDeleting(false);
    }
  };

  if (props.projects.length === 0) {
    return (
      <div className="empty">
        <p>No projects yet.</p>
        <p className="muted">
          Pick a video to start the Intake {"→"} Phases {"→"} Segmentation {"→"} Export pipeline.
        </p>
      </div>
    );
  }
  return (
    <table className="projects">
      <thead>
        <tr>
          <th>Project</th>
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
            onClick={() => props.onOpen(p.id)}
          >
            <td>
              <div className="proj-name">{p.name}</div>
              <div className="proj-id muted">{p.id}</div>
            </td>
            <td>
              <StageBar statuses={p.stageStatuses} />
            </td>
            <td>
              <StageBadge status={p.currentStatus} /> {STAGE_LABELS[p.currentStage]}
            </td>
            <td className="muted">{formatTime(p.updatedAt)}</td>
            <td onClick={(e) => e.stopPropagation()}>
              {confirming === p.id ? (
                <div className="delete-confirm">
                  <button className="danger" onClick={() => void remove(p.id)} disabled={deleting}>
                    Delete
                  </button>
                  <button className="secondary" onClick={() => setConfirming(null)} disabled={deleting}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="secondary"
                  title="Remove from the list (moved to the library's deleted folder; exported clips are kept)"
                  onClick={() => setConfirming(p.id)}
                >
                  Delete…
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
