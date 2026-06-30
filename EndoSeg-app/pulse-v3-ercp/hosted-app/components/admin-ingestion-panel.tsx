"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type IngestionMode = "images" | "video";
type IngestionState = "idle" | "uploaded" | "processing" | "ready" | "saved" | "failed";
type FrameMeta = {
  name: string;
  width: number;
  height: number;
};
type PreviewFrame = {
  name: string;
  url: string;
};

const DEFAULT_VIDEO_INTERVAL_SECONDS = 2;
const MAX_EXTRACTED_FRAMES = 240;

function stateTone(state: IngestionState) {
  if (state === "saved") return "completed";
  if (state === "ready") return "active";
  if (state === "processing" || state === "uploaded") return "pending";
  if (state === "failed") return "danger";
  return "archived";
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSeconds(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function estimateFrameCount(durationSeconds: number, intervalSeconds: number) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || intervalSeconds <= 0) return 0;
  return Math.max(1, Math.floor(durationSeconds / intervalSeconds) + 1);
}

function deriveFallbackSummary({
  mode,
  externalCaseId,
  imageFrames,
  videoFile,
}: {
  mode: IngestionMode;
  externalCaseId: string;
  imageFrames: File[];
  videoFile: File | null;
}) {
  const trimmedCaseId = externalCaseId.trim();
  if (trimmedCaseId) {
    return `${trimmedCaseId} ingestion`;
  }

  if (mode === "video" && videoFile) {
    return `Video-derived case from ${videoFile.name}`;
  }

  if (imageFrames.length) {
    return `Image-derived case from ${imageFrames[0].name}`;
  }

  return "Hosted ingestion case";
}

async function readImageDimensions(file: File): Promise<FrameMeta> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      image.src = objectUrl;
    });

    return {
      name: file.name,
      width: dimensions.width,
      height: dimensions.height,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function readVideoMetadata(file: File) {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.playsInline = true;
      video.muted = true;
      video.onloadedmetadata = () => {
        resolve({
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
        });
      };
      video.onerror = () => reject(new Error(`Could not inspect ${file.name}.`));
      video.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function extractFramesFromVideo(file: File, intervalSeconds: number) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.preload = "auto";
    video.playsInline = true;
    video.muted = true;
    video.src = objectUrl;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error(`Could not decode ${file.name}.`));
    });

    const width = video.videoWidth;
    const height = video.videoHeight;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Video duration is unavailable.");
    }

    const timestamps: number[] = [];
    for (let current = 0; current < duration; current += intervalSeconds) {
      timestamps.push(Number(current.toFixed(3)));
    }
    const lastTimestamp = Number(Math.max(duration - 0.05, 0).toFixed(3));
    if (!timestamps.length || timestamps[timestamps.length - 1] < lastTimestamp) {
      timestamps.push(lastTimestamp);
    }
    if (timestamps.length > MAX_EXTRACTED_FRAMES) {
      throw new Error(
        `Estimated extraction exceeds ${MAX_EXTRACTED_FRAMES} frames. Increase the interval and try again.`,
      );
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas extraction is unavailable in this browser.");
    }

    const extractedFrames: File[] = [];
    const frameMeta: FrameMeta[] = [];

    for (let index = 0; index < timestamps.length; index += 1) {
      const timestamp = timestamps[index];
      await new Promise<void>((resolve, reject) => {
        const handleSeeked = () => {
          video.removeEventListener("seeked", handleSeeked);
          video.removeEventListener("error", handleError);
          resolve();
        };
        const handleError = () => {
          video.removeEventListener("seeked", handleSeeked);
          video.removeEventListener("error", handleError);
          reject(new Error(`Failed to seek frame ${index + 1}.`));
        };
        video.addEventListener("seeked", handleSeeked, { once: true });
        video.addEventListener("error", handleError, { once: true });
        video.currentTime = timestamp;
      });

      context.drawImage(video, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => {
          if (!value) {
            reject(new Error(`Failed to render frame ${index + 1}.`));
            return;
          }
          resolve(value);
        }, "image/png");
      });

      const name = `frame_${String(index + 1).padStart(4, "0")}.png`;
      extractedFrames.push(new File([blob], name, { type: "image/png" }));
      frameMeta.push({ name, width, height });
    }

    return {
      duration,
      width,
      height,
      frames: extractedFrames,
      frameMeta,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function AdminIngestionPanel() {
  const router = useRouter();
  const [mode, setMode] = useState<IngestionMode>("images");
  const [summary, setSummary] = useState("");
  const [externalCaseId, setExternalCaseId] = useState("");
  const [priority, setPriority] = useState("routine");

  const [imageFrames, setImageFrames] = useState<File[]>([]);
  const [imageFrameMeta, setImageFrameMeta] = useState<FrameMeta[]>([]);
  const [imageReports, setImageReports] = useState<File[]>([]);
  const [imageState, setImageState] = useState<IngestionState>("idle");
  const [imageMessage, setImageMessage] = useState("");

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoReports, setVideoReports] = useState<File[]>([]);
  const [videoState, setVideoState] = useState<IngestionState>("idle");
  const [videoMessage, setVideoMessage] = useState("");
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number } | null>(null);
  const [videoIntervalSeconds, setVideoIntervalSeconds] = useState<number>(DEFAULT_VIDEO_INTERVAL_SECONDS);
  const [extractedFrames, setExtractedFrames] = useState<File[]>([]);
  const [extractedFrameMeta, setExtractedFrameMeta] = useState<FrameMeta[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [createdCase, setCreatedCase] = useState<{
    caseId: string;
    displayCaseId: string;
    frameCount: number;
    status: string;
  } | null>(null);

  const estimatedVideoFrameCount = useMemo(
    () =>
      videoDuration && videoIntervalSeconds > 0
        ? estimateFrameCount(videoDuration, videoIntervalSeconds)
        : 0,
    [videoDuration, videoIntervalSeconds],
  );
  const tooManyEstimatedFrames = estimatedVideoFrameCount > MAX_EXTRACTED_FRAMES;
  const activeFrames = mode === "images" ? imageFrames : extractedFrames;
  const activeFrameMeta = mode === "images" ? imageFrameMeta : extractedFrameMeta;
  const activeReports = mode === "images" ? imageReports : videoReports;
  const activeState = mode === "images" ? imageState : videoState;
  const activeMessage = mode === "images" ? imageMessage : videoMessage;

  const previewFrames = useMemo<PreviewFrame[]>(() => {
    return activeFrames.slice(0, 18).map((file) => ({
      name: file.name,
      url: URL.createObjectURL(file),
    }));
  }, [activeFrames]);

  useEffect(() => {
    return () => {
      previewFrames.forEach((frame) => URL.revokeObjectURL(frame.url));
    };
  }, [previewFrames]);

  async function handleImageFrameChange(files: FileList | null) {
    const nextFrames = files ? Array.from(files) : [];
    setImageFrames(nextFrames);
    setCreatedCase(null);
    setSubmitError("");

    if (!nextFrames.length) {
      setImageFrameMeta([]);
      setImageState("idle");
      setImageMessage("");
      return;
    }

    setImageState("processing");
    setImageMessage("Inspecting selected frames.");
    try {
      const metadata = await Promise.all(nextFrames.map((file) => readImageDimensions(file)));
      setImageFrameMeta(metadata);
      setImageState("ready");
      setImageMessage(`${nextFrames.length} frame(s) ready for review.`);
    } catch (error) {
      setImageFrameMeta([]);
      setImageState("failed");
      setImageMessage(error instanceof Error ? error.message : "Could not inspect the selected frames.");
    }
  }

  async function handleVideoFileChange(file: File | null) {
    setVideoFile(file);
    setExtractedFrames([]);
    setExtractedFrameMeta([]);
    setCreatedCase(null);
    setSubmitError("");

    if (!file) {
      setVideoState("idle");
      setVideoMessage("");
      setVideoDuration(null);
      setVideoDimensions(null);
      return;
    }

    setVideoState("uploaded");
    setVideoMessage("Video uploaded. Choose an interval and extract frames.");
    try {
      const metadata = await readVideoMetadata(file);
      setVideoDuration(metadata.duration);
      setVideoDimensions({ width: metadata.width, height: metadata.height });
    } catch (error) {
      setVideoState("failed");
      setVideoMessage(error instanceof Error ? error.message : "Could not inspect the uploaded video.");
      setVideoDuration(null);
      setVideoDimensions(null);
    }
  }

  async function handleExtractFrames() {
    if (!videoFile) return;
    if (videoIntervalSeconds <= 0) {
      setVideoState("failed");
      setVideoMessage("Extraction interval must be greater than zero.");
      return;
    }
    if (tooManyEstimatedFrames) {
      setVideoState("failed");
      setVideoMessage(
        `Estimated extraction exceeds ${MAX_EXTRACTED_FRAMES} frames. Increase the interval first.`,
      );
      return;
    }

    setVideoState("processing");
    setVideoMessage("Extracting frames from the uploaded video.");
    setSubmitError("");
    try {
      const result = await extractFramesFromVideo(videoFile, videoIntervalSeconds);
      setExtractedFrames(result.frames);
      setExtractedFrameMeta(result.frameMeta);
      setVideoDuration(result.duration);
      setVideoDimensions({ width: result.width, height: result.height });
      setVideoState("ready");
      setVideoMessage(`${result.frames.length} frame(s) extracted and ready for preview.`);
    } catch (error) {
      setExtractedFrames([]);
      setExtractedFrameMeta([]);
      setVideoState("failed");
      setVideoMessage(error instanceof Error ? error.message : "Frame extraction failed.");
    }
  }

  async function submitIngestion() {
    setSubmitting(true);
    setSubmitError("");
    setCreatedCase(null);
    if (mode === "images") {
      setImageState("processing");
      setImageMessage("Creating hosted case from uploaded frames.");
    } else {
      setVideoState("processing");
      setVideoMessage("Creating hosted case from extracted frames.");
    }

    const formData = new FormData();
    formData.set("mode", mode);
    const normalizedSummary =
      summary.trim() ||
      deriveFallbackSummary({
        mode,
        externalCaseId,
        imageFrames,
        videoFile,
      });
    formData.set("summary", normalizedSummary);
    formData.set("externalCaseId", externalCaseId);
    formData.set("priority", priority);

    if (mode === "images") {
      imageFrames.forEach((file) => formData.append("frames", file));
      imageReports.forEach((file) => formData.append("reports", file));
      formData.set("frameMeta", JSON.stringify(imageFrameMeta));
    } else {
      if (!videoFile) {
        setSubmitting(false);
        setSubmitError("Upload a video first.");
        return;
      }
      if (!extractedFrames.length) {
        setSubmitting(false);
        setSubmitError("Extract frames before creating the case.");
        return;
      }
      formData.set("uploadFilename", videoFile.name);
      formData.set("extractionIntervalSeconds", String(videoIntervalSeconds));
      extractedFrames.forEach((file) => formData.append("frames", file));
      videoReports.forEach((file) => formData.append("reports", file));
      formData.set("frameMeta", JSON.stringify(extractedFrameMeta));
    }

    try {
      const response = await fetch("/api/admin/ingest", {
        method: "POST",
        body: formData,
        credentials: "same-origin",
      });

      const payload = (await response.json()) as
        | { ok: true; caseId: string; displayCaseId: string; frameCount: number; status: string }
        | { ok: false; error: string };

      if (!response.ok || !payload.ok) {
        throw new Error(payload.ok ? "Case ingestion failed." : payload.error);
      }

      setCreatedCase({
        caseId: payload.caseId,
        displayCaseId: payload.displayCaseId,
        frameCount: payload.frameCount,
        status: payload.status,
      });
      if (mode === "images") {
        setImageState("saved");
        setImageMessage("Hosted case saved and ready for workflow assignment.");
      } else {
        setVideoState("saved");
        setVideoMessage("Hosted case saved from extracted video frames and is ready for workflow assignment.");
      }
      router.refresh();
    } catch (error) {
      if (mode === "images") {
        setImageState("failed");
      } else {
        setVideoState("failed");
      }
      setSubmitError(error instanceof Error ? error.message : "Case ingestion failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="table-card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <p className="eyebrow">Admin ingestion</p>
          <h3>Create hosted case</h3>
          <p className="muted" style={{ margin: 0 }}>
            Upload frames directly or upload a video and extract frames before sending the case into workflow.
          </p>
        </div>
        <div className={`chip ${stateTone(activeState)}`}>{activeState}</div>
      </div>

      <div className="ingestion-mode-toggle" role="tablist" aria-label="Case ingestion mode">
        <button
          className={`button ${mode === "images" ? "primary" : "ghost"}`}
          onClick={() => setMode("images")}
          type="button"
        >
          Upload images
        </button>
        <button
          className={`button ${mode === "video" ? "primary" : "ghost"}`}
          onClick={() => setMode("video")}
          type="button"
        >
          Upload video
        </button>
      </div>

      <div className="form-grid">
        <div className="field">
          <label htmlFor="ingestion-summary">Case summary</label>
          <textarea
            id="ingestion-summary"
            rows={3}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="Short reviewer-facing summary (optional)"
          />
          <div className="muted">
            If left blank, a simple summary will be generated from the case ID or uploaded file.
          </div>
        </div>
        <div className="ingestion-grid">
          <div className="field">
            <label htmlFor="ingestion-external-case-id">External case ID</label>
            <input
              id="ingestion-external-case-id"
              value={externalCaseId}
              onChange={(event) => setExternalCaseId(event.target.value)}
              placeholder="study-alpha-005"
            />
          </div>
          <div className="field">
            <label htmlFor="ingestion-priority">Priority</label>
            <select
              id="ingestion-priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            >
              <option value="routine">routine</option>
              <option value="priority">priority</option>
              <option value="urgent">urgent</option>
            </select>
          </div>
        </div>

        {mode === "images" ? (
          <>
            <div className="field">
              <label htmlFor="image-frames">Frame images</label>
              <input
                accept="image/*"
                id="image-frames"
                multiple
                onChange={(event) => void handleImageFrameChange(event.target.files)}
                type="file"
              />
            </div>
            <div className="field">
              <label htmlFor="image-reports">Optional report files</label>
              <input
                accept="image/*,.pdf,application/pdf"
                id="image-reports"
                multiple
                onChange={(event) => setImageReports(event.target.files ? Array.from(event.target.files) : [])}
                type="file"
              />
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="video-upload">Video file</label>
              <input
                accept="video/*"
                id="video-upload"
                onChange={(event) => void handleVideoFileChange(event.target.files?.[0] || null)}
                type="file"
              />
            </div>
            <div className="ingestion-grid">
              <div className="field">
                <label htmlFor="video-interval">Extraction interval (seconds)</label>
                <input
                  id="video-interval"
                  min={0.25}
                  onChange={(event) => setVideoIntervalSeconds(Number(event.target.value) || DEFAULT_VIDEO_INTERVAL_SECONDS)}
                  step={0.25}
                  type="number"
                  value={videoIntervalSeconds}
                />
              </div>
              <div className="field">
                <label htmlFor="video-reports">Optional report files</label>
                <input
                  accept="image/*,.pdf,application/pdf"
                  id="video-reports"
                  multiple
                  onChange={(event) => setVideoReports(event.target.files ? Array.from(event.target.files) : [])}
                  type="file"
                />
              </div>
            </div>
            <div className="row">
              <button
                className="button ghost"
                disabled={!videoFile || tooManyEstimatedFrames}
                onClick={() => void handleExtractFrames()}
                type="button"
              >
                {extractedFrames.length ? "Re-extract frames" : "Extract frames"}
              </button>
            </div>
            <div className="ingestion-helper-grid">
              <div className="meta-item">
                <span className="meta-label">Duration</span>
                <span className="meta-value">{videoDuration ? formatSeconds(videoDuration) : "Waiting for video"}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Frame estimate</span>
                <span className="meta-value">
                  {estimatedVideoFrameCount ? `${estimatedVideoFrameCount} frames` : "Set interval"}
                </span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Video size</span>
                <span className="meta-value">
                  {videoDimensions ? `${videoDimensions.width} × ${videoDimensions.height}` : "Pending"}
                </span>
              </div>
            </div>
            {tooManyEstimatedFrames ? (
              <div className="notice warning">
                Increase the interval before extraction. The current estimate exceeds {MAX_EXTRACTED_FRAMES} frames.
              </div>
            ) : null}
          </>
        )}

        {activeMessage ? (
          <div className={`notice ${activeState === "failed" ? "warning" : activeState === "ready" ? "success" : ""}`}>
            {activeMessage}
          </div>
        ) : null}

        <div className="ingestion-preview-grid">
          <section className="card">
            <h4 style={{ margin: "0 0 8px" }}>Frame thumbnails</h4>
            {previewFrames.length ? (
              <div className="ingestion-thumbnail-grid">
                {previewFrames.map((frame) => (
                  <figure className="ingestion-thumbnail-card" key={frame.name}>
                    <img alt={frame.name} className="ingestion-thumbnail-image" src={frame.url} />
                    <figcaption title={frame.name}>{frame.name}</figcaption>
                  </figure>
                ))}
              </div>
            ) : (
              <div className="empty">
                {mode === "images"
                  ? "Choose frame images to preview thumbnails."
                  : "Extract frames from the uploaded video to preview the generated thumbnails."}
              </div>
            )}
          </section>

          <section className="card">
            <h4 style={{ margin: "0 0 8px" }}>Frame preview</h4>
            {activeFrames.length ? (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Name</th>
                      <th>Dimensions</th>
                      <th>Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeFrames.map((file, index) => {
                      const meta = activeFrameMeta[index];
                      return (
                        <tr key={`${file.name}-${index}`}>
                          <td>{index + 1}</td>
                          <td title={file.name}>{file.name}</td>
                          <td>{meta ? `${meta.width} × ${meta.height}` : "Pending"}</td>
                          <td>{formatBytes(file.size)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">
                {mode === "images"
                  ? "Choose frame images to preview the ordered list."
                  : "Extract frames from the uploaded video to preview the generated frame set."}
              </div>
            )}
          </section>

          <section className="card">
            <h4 style={{ margin: "0 0 8px" }}>Report files</h4>
            {activeReports.length ? (
              <div className="stack">
                {activeReports.map((file) => (
                  <div className="row" key={file.name} style={{ justifyContent: "space-between" }}>
                    <span title={file.name}>{file.name}</span>
                    <span className="muted">{formatBytes(file.size)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">No report files selected. Add a PDF to make report access reviewer-friendly.</div>
            )}
          </section>
        </div>

        {submitError ? <div className="notice warning">{submitError}</div> : null}
        {createdCase ? (
          <div className="notice success">
            Saved hosted case <strong>{createdCase.displayCaseId}</strong> with {createdCase.frameCount} frame(s).
            <div style={{ marginTop: 8 }}>
              Status: <strong>{createdCase.status}</strong>. Reviewers will see this case after a reviewer chain is assigned.
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Link className="button primary" href={`/cases/${createdCase.caseId}`}>
                Open case and assign workflow
              </Link>
              <Link className="button ghost" href="/admin/cases">
                View admin case list
              </Link>
            </div>
          </div>
        ) : null}

        <div className="row">
          <button
            className="button primary"
            disabled={
              submitting ||
              !activeFrames.length ||
              (mode === "video" && !extractedFrames.length)
            }
            onClick={() => void submitIngestion()}
            type="button"
          >
            {submitting ? "Creating case..." : "Create hosted case"}
          </button>
        </div>
      </div>
    </section>
  );
}
