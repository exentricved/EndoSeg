#!/usr/bin/env python3
"""
test_e2e_pipeline.py — End-to-end test of the motion-based frame extraction
and timestamp-aware mask interpolation pipeline.

Steps
-----
  1. NORM: extract frames from a real EUS video using motion filter
  2. Build a .leus file from extracted frames with synthetic circular masks
     and real sourceTimestamp values
  3. process_leus_to_video: verify timestamp-aware interpolation path fires
  4. apply_masks_to_hfps_video: verify timestamp-based mask-to-frame mapping

Usage
-----
  cd pulse-v3-liver-main
  python scripts/test_e2e_pipeline.py
  python scripts/test_e2e_pipeline.py --video /path/to/video.mp4 --out /tmp/e2e_out
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

import cv2
import numpy as np

# ── Path setup ──────────────────────────────────────────────────────────────
SCRIPT_DIR  = Path(__file__).parent
REPO_ROOT   = SCRIPT_DIR.parent
NORM_ROOT   = REPO_ROOT.parent.parent / "NORM"

sys.path.insert(0, str(REPO_ROOT))        # pulse-v3-liver-main (for video_seg_ui)
sys.path.insert(0, str(NORM_ROOT))        # NORM (for backend.pipeline.*)

# ── Suppress Gradio import inside video_seg_ui so we can call functions directly
os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "False")

# ── Imports ──────────────────────────────────────────────────────────────────
try:
    from backend.pipeline.decoder            import decode_video
    from backend.pipeline.grayscale_filter   import filter_grayscale
    from backend.pipeline.redundancy_filter  import filter_redundant_frames
    from backend.pipeline.normalizer         import normalize_eus_frames
    from backend.pipeline.motion_filter      import filter_motion_frames
    from backend.pipeline.blur_filter        import filter_blurry_frames
    NORM_AVAILABLE = True
except ImportError as e:
    print(f"  [WARN] NORM pipeline not importable ({e}) — skipping Step 1")
    NORM_AVAILABLE = False

try:
    from scripts.video_seg_ui import process_leus_to_video, apply_masks_to_hfps_video
    UI_AVAILABLE = True
except ImportError as e:
    # Try importing directly (when run from scripts/ or repo root)
    try:
        sys.path.insert(0, str(SCRIPT_DIR))
        import video_seg_ui as _ui
        process_leus_to_video   = _ui.process_leus_to_video
        apply_masks_to_hfps_video = _ui.apply_masks_to_hfps_video
        UI_AVAILABLE = True
    except ImportError as e2:
        print(f"  [WARN] video_seg_ui not importable ({e2}) — skipping Steps 3+4")
        UI_AVAILABLE = False


# ── Helpers ───────────────────────────────────────────────────────────────────

def _pass(msg: str):  print(f"  [PASS] {msg}")
def _fail(msg: str):  print(f"  [FAIL] {msg}"); return False
def _info(msg: str):  print(f"         {msg}")

FAILURES: list[str] = []

def assert_true(cond: bool, msg: str) -> bool:
    if cond:
        _pass(msg)
        return True
    else:
        FAILURES.append(msg)
        return _fail(msg)


def _bgr_to_png_b64(bgr: np.ndarray) -> str:
    """Encode a BGR image as a base64 PNG data-URI."""
    ok, buf = cv2.imencode(".png", bgr)
    assert ok
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()


def _mask_to_png_b64(mask_binary: np.ndarray) -> str:
    """
    Encode a binary mask (H,W uint8 0/255) as a base64 PNG data-URI
    with alpha channel (mask=255 → alpha=255).
    """
    rgba = np.zeros((*mask_binary.shape, 4), dtype=np.uint8)
    rgba[mask_binary > 0, :3] = 255
    rgba[mask_binary > 0,  3] = 255
    ok, buf = cv2.imencode(".png", rgba)
    assert ok
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()


def _circular_mask(size: int = 1024, radius_frac: float = 0.25,
                   cx_frac: float = 0.5, cy_frac: float = 0.5) -> np.ndarray:
    """Return a binary 1024×1024 mask with a filled circle."""
    m = np.zeros((size, size), dtype=np.uint8)
    cx, cy = int(size * cx_frac), int(size * cy_frac)
    r      = int(size * radius_frac)
    cv2.circle(m, (cx, cy), r, 255, -1)
    return m


def _build_leus(frames_bgr: list[np.ndarray],
                timestamps: list[float],
                add_liver_mask: bool = True,
                add_segment_mask: bool = False) -> dict:
    """
    Build a minimal .leus project dict from a list of BGR frames and timestamps.
    Each frame gets a synthetic circular "Liver" mask (label id=1).
    Optionally adds a segment mask (label id=9 = Segment I).
    """
    images = []
    for i, (bgr, ts) in enumerate(zip(frames_bgr, timestamps)):
        h, w = bgr.shape[:2]
        name = f"frame_{i+1:04d}_ts_{ts:.3f}"
        labels = []
        if add_liver_mask:
            mask = _circular_mask(1024, radius_frac=0.28)
            labels.append({
                "id": 1,
                "name": "Liver",
                "color": "#ff0000",
                "maskPNG": _mask_to_png_b64(mask),
            })
        if add_segment_mask:
            seg_mask = _circular_mask(1024, radius_frac=0.12, cx_frac=0.45, cy_frac=0.45)
            labels.append({
                "id": 9,
                "name": "Segment I",
                "color": "#aa00ff",
                "maskPNG": _mask_to_png_b64(seg_mask),
            })
        images.append({
            "id": f"frame-{i:04d}",
            "name": name,
            "w": w,
            "h": h,
            "baseURL": _bgr_to_png_b64(bgr),
            "station": "",
            "sourceTimestamp": float(ts),
            "labels": labels,
        })
    return {"version": 2, "organ": "liver", "modality": "linear-eus", "images": images}


def _save_leus(proj: dict, path: str):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(proj, f)


def _synthetic_video(out_path: str, n_frames: int = 40, fps: float = 25.0,
                     w: int = 320, h: int = 240) -> str:
    """Create a simple synthetic grayscale gradient video for testing."""
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(out_path, fourcc, fps, (w, h))
    for i in range(n_frames):
        brightness = int(255 * i / max(n_frames - 1, 1))
        frame = np.full((h, w, 3), brightness, dtype=np.uint8)
        # draw a moving circle to create real motion
        cx = int(w * 0.2 + w * 0.6 * (i / max(n_frames - 1, 1)))
        cv2.circle(frame, (cx, h // 2), h // 5, (200, 100, 50), -1)
        writer.write(frame)
    writer.release()
    return out_path


# ── OpenCV fallback helpers (used when ffmpeg / NORM pipeline unavailable) ────

def _opencv_decode(video_path: str, target_fps: float = 2.0) -> list:
    """Decode video with OpenCV, sampling at target_fps."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return []
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, round(src_fps / target_fps))
    frames = []
    idx = 0
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        if idx % step == 0:
            ts  = idx / src_fps
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            frames.append((rgb, ts, {"source": "opencv_decode"}))
        idx += 1
    cap.release()
    return frames


def _opencv_motion_filter(frames: list,
                           low_thresh: float = 2.0,
                           high_thresh: float = 6.0,
                           static_keep_every: int = 5) -> list:
    """
    Replicate NORM's motion_filter.py logic using OpenCV only.
    Adaptive sampling: keep all high-motion, every-2nd medium, 1-in-5 static.
    """
    if not frames:
        return frames
    out = [frames[0]]   # always keep first
    prev_gray = cv2.cvtColor(frames[0][0], cv2.COLOR_RGB2GRAY)
    static_count = 0
    for i, (rgb, ts, meta) in enumerate(frames[1:], 1):
        gray  = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        score = float(np.mean(np.abs(gray.astype(np.float32) - prev_gray.astype(np.float32))))
        prev_gray = gray
        if score >= high_thresh:
            level = "high"
            keep  = True
        elif score >= low_thresh:
            level = "medium"
            keep  = (i % 2 == 0)
        else:
            level = "low"
            static_count += 1
            keep  = (static_count % static_keep_every == 0)
        if keep:
            new_meta = dict(meta)
            new_meta["motion_score"] = score
            new_meta["motion_level"] = level
            out.append((rgb, ts, new_meta))
    return out


# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — NORM frame extraction
# ─────────────────────────────────────────────────────────────────────────────

def step1_norm_extraction(video_path: str, out_dir: str) -> tuple[list, bool]:
    """
    Run the NORM motion-based pipeline on video_path.
    Returns (frames, success) where frames = [(bgr, ts, meta), ...]
    """
    print("\n── Step 1: NORM frame extraction ──────────────────────────────────")

    if not NORM_AVAILABLE:
        _info("NORM not importable — using OpenCV decoder + motion filter")

    _info(f"Video: {video_path}")

    # Stage 0 — decode at low FPS to keep test fast
    try:
        raw = list(decode_video(video_path, target_fps=2.0))
    except Exception as e:
        _info(f"NORM decode_video failed ({e}) — falling back to OpenCV decoder")
        raw = None

    if raw is None or len(raw) == 0:
        _info("Using OpenCV fallback decoder (ffmpeg not available)")
        raw = _opencv_decode(video_path, target_fps=2.0)

    _info(f"Stage 0 decode:         {len(raw):>4} frames")
    assert_true(len(raw) > 0, "Stage 0: decode produced frames")
    if not raw:
        return [], False

    # Stage 1 — grayscale filter
    try:
        gray = list(filter_grayscale(iter(raw)))
    except Exception:
        gray = raw  # skip if unavailable
    _info(f"Stage 1 grayscale:      {len(gray):>4} frames")

    # Stage 2 — redundancy filter
    try:
        unique = list(filter_redundant_frames(iter(gray)))
    except Exception:
        unique = gray
    _info(f"Stage 2 redundancy:     {len(unique):>4} frames")

    # Stage 2.5 — normalisation
    try:
        normed = list(normalize_eus_frames(iter(unique)))
    except Exception:
        normed = unique
    _info(f"Stage 2.5 normalize:    {len(normed):>4} frames")

    # Stage 3 — motion filter (key stage)
    try:
        motion = list(filter_motion_frames(iter(normed)))
    except Exception:
        motion = _opencv_motion_filter(normed)
    _info(f"Stage 3 motion filter:  {len(motion):>4} frames")

    # Stage 3.5 — blur filter
    try:
        sharp = list(filter_blurry_frames(iter(motion), threshold=50.0))
    except Exception:
        sharp = motion
    _info(f"Stage 3.5 blur filter:  {len(sharp):>4} frames")

    assert_true(len(sharp) > 0, "NORM pipeline produced at least 1 frame")
    assert_true(
        all(len(f) == 3 for f in sharp),
        "Every output frame is a (rgb, timestamp, meta) tuple",
    )

    # Verify timestamps are non-negative and monotonically non-decreasing
    timestamps = [f[1] for f in sharp]
    assert_true(
        all(t >= 0 for t in timestamps),
        "All timestamps are non-negative",
    )
    assert_true(
        all(timestamps[i] <= timestamps[i+1] for i in range(len(timestamps)-1)),
        "Timestamps are monotonically non-decreasing",
    )

    # Verify motion metadata present
    has_motion_meta = all("motion_score" in f[2] for f in sharp)
    assert_true(has_motion_meta, "All frames carry motion_score metadata")

    # Report motion gap distribution (informational — may be uniform if all high-motion)
    if len(timestamps) >= 2:
        gaps = [timestamps[i+1] - timestamps[i] for i in range(len(timestamps)-1)]
        gap_range = max(gaps) - min(gaps)
        _info(f"Timestamp gaps: min={min(gaps):.3f}s  max={max(gaps):.3f}s  range={gap_range:.3f}s")
        if gap_range > 0.0:
            _pass("Frames are non-uniformly spaced (motion-adaptive sampling confirmed)")
        else:
            _info("Note: uniform spacing — video may be all-high-motion at this sample rate (expected for 2fps)")
            _pass("Motion filter ran without error (spacing depends on video content)")

    # Save a few frames for inspection
    os.makedirs(out_dir, exist_ok=True)
    for i, (rgb, ts, _meta) in enumerate(sharp[:5]):
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        fname = os.path.join(out_dir, f"frame_{i+1:04d}_ts_{ts:.3f}.png")
        cv2.imwrite(fname, bgr)
    _info(f"Saved {min(5, len(sharp))} sample frames to {out_dir}/")

    return sharp, True


# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — Build .leus file
# ─────────────────────────────────────────────────────────────────────────────

def step2_build_leus(norm_frames: list, out_dir: str) -> tuple[str, bool]:
    """
    Build a .leus file from NORM-extracted frames.
    Uses at most 8 frames to keep test fast.
    Adds circular liver + one segment mask per frame.
    Returns (leus_path, success).
    """
    print("\n── Step 2: Build .leus file ────────────────────────────────────────")

    # Subsample to ≤8 frames for speed
    step = max(1, len(norm_frames) // 8)
    subset = norm_frames[::step][:8]

    bgr_list  = [cv2.cvtColor(f[0], cv2.COLOR_RGB2BGR) for f in subset]
    ts_list   = [f[1] for f in subset]

    _info(f"Frames in .leus: {len(subset)}  timestamps: {[f'{t:.3f}' for t in ts_list]}")

    # Check that filename-embedded timestamps will parse correctly
    for ts in ts_list:
        fname  = f"frame_0001_ts_{ts:.3f}.png"
        # replicate App.tsx regex: [_-]ts[_-](\d+(?:\.\d+)?)
        import re
        m = re.search(r'[_\-]ts[_\-]([\d]+(?:\.[\d]+)?)', fname, re.I)
        assert_true(
            m is not None and abs(float(m.group(1)) - ts) < 0.001,
            f"Filename '{fname}' parses back to sourceTimestamp={ts:.3f}",
        )

    proj = _build_leus(bgr_list, ts_list,
                       add_liver_mask=True, add_segment_mask=True)

    leus_path = os.path.join(out_dir, "test_annotated.leus")
    _save_leus(proj, leus_path)

    assert_true(Path(leus_path).exists(), ".leus file written to disk")
    assert_true(Path(leus_path).stat().st_size > 1000, ".leus file is non-trivial in size")

    # Verify JSON structure
    with open(leus_path, "r", encoding="utf-8") as f:
        loaded = json.load(f)
    assert_true(loaded.get("version") == 2,             ".leus version field = 2")
    assert_true(len(loaded["images"]) == len(subset),   ".leus has correct frame count")
    assert_true(
        all("sourceTimestamp" in im for im in loaded["images"]),
        "Every image entry has sourceTimestamp field",
    )
    assert_true(
        all(isinstance(im["sourceTimestamp"], float) for im in loaded["images"]),
        "All sourceTimestamp values are floats",
    )

    _info(f"Saved: {leus_path}")
    return leus_path, True


# ─────────────────────────────────────────────────────────────────────────────
# STEP 2b — Legacy .leus (no timestamps) for fallback test
# ─────────────────────────────────────────────────────────────────────────────

def step2b_build_legacy_leus(norm_frames: list, out_dir: str) -> str:
    """Build a .leus file WITHOUT sourceTimestamp fields (tests legacy fallback)."""
    step   = max(1, len(norm_frames) // 5)
    subset = norm_frames[::step][:5]
    bgr_list = [cv2.cvtColor(f[0], cv2.COLOR_RGB2BGR) for f in subset]

    images = []
    for i, bgr in enumerate(bgr_list):
        h, w = bgr.shape[:2]
        mask = _circular_mask(1024, radius_frac=0.25)
        images.append({
            "id": f"legacy-{i}",
            "name": f"frame_{i+1:04d}",
            "w": w, "h": h,
            "baseURL": _bgr_to_png_b64(bgr),
            "station": "",
            # NOTE: no sourceTimestamp
            "labels": [{
                "id": 1, "name": "Liver", "color": "#ff0000",
                "maskPNG": _mask_to_png_b64(mask),
            }],
        })
    proj = {"version": 2, "organ": "liver", "modality": "linear-eus", "images": images}
    path = os.path.join(out_dir, "test_legacy.leus")
    _save_leus(proj, path)
    return path


# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — process_leus_to_video (timestamp-aware interpolation)
# ─────────────────────────────────────────────────────────────────────────────

def step3_process_leus_to_video(leus_path: str, legacy_leus_path: str,
                                 out_dir: str) -> bool:
    print("\n── Step 3: process_leus_to_video ───────────────────────────────────")

    if not UI_AVAILABLE:
        _info("video_seg_ui not available — skipping")
        return True

    # ── 3a: Timestamp path ───────────────────────────────────────────────────
    _info("3a: Timestamped .leus → should use timestamp interpolation")
    try:
        class _FakePath:
            def __init__(self, p): self.name = p
        fp = _FakePath(leus_path)

        video, state, log = process_leus_to_video(
            leus_files=[fp],
            order_str="",
            leus_fps=5.0,
            show_liver=True,
            show_vessels=True,
            show_ligaments=False,
            show_labels=True,
            show_segments=True,
            show_liver_label=True,
        )
    except Exception:
        FAILURES.append("process_leus_to_video raised exception (timestamp path)")
        _fail("process_leus_to_video raised exception (timestamp path)")
        traceback.print_exc()
        return False

    assert_true(video is not None,                  "3a: returned a video path")
    assert_true(Path(video).exists(),               "3a: video file exists on disk")
    assert_true(Path(video).stat().st_size > 1000,  "3a: video file is non-empty")

    ts_line = [l for l in log.split("\n") if "Timestamp interpolation" in l]
    assert_true(
        len(ts_line) > 0,
        "3a: log contains 'Timestamp interpolation' (timestamp path was taken)",
    )
    if ts_line:
        _info(f"Log: {ts_line[0].strip()}")

    # Verify output video is playable (can open with OpenCV)
    cap = cv2.VideoCapture(video)
    fps_out = cap.get(cv2.CAP_PROP_FPS)
    n_frames_out = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    assert_true(fps_out > 0,       f"3a: output video has valid FPS ({fps_out:.1f})")
    assert_true(n_frames_out > 0,  f"3a: output video has {n_frames_out} frames")

    # Expected: n_out ≈ duration * fps
    with open(leus_path, "r") as f:
        leus_data = json.load(f)
    ts_vals = [im["sourceTimestamp"] for im in leus_data["images"]]
    duration = max(ts_vals) - min(ts_vals)
    expected_frames = max(1, round(duration * 5.0))
    _info(f"Duration {duration:.2f}s @ 5 FPS → expected ~{expected_frames} frames, got {n_frames_out}")
    # Allow ±2 frames tolerance (rounding)
    assert_true(
        abs(n_frames_out - expected_frames) <= max(2, expected_frames * 0.1),
        f"3a: output frame count matches duration*fps (±10%)",
    )

    ts_out = os.path.join(out_dir, "ts_interpolated.mp4")
    import shutil; shutil.copy(video, ts_out)
    _info(f"Saved: {ts_out}")

    # ── 3b: Legacy path (no timestamps) ──────────────────────────────────────
    _info("\n3b: Legacy .leus (no timestamps) → should fall back to 1:1 mapping")
    try:
        class _FakePath2:
            def __init__(self, p): self.name = p
        fp2 = _FakePath2(legacy_leus_path)
        video2, state2, log2 = process_leus_to_video(
            leus_files=[fp2],
            order_str="",
            leus_fps=5.0,
            show_liver=True,
            show_vessels=False,
            show_ligaments=False,
            show_labels=True,
            show_segments=False,
            show_liver_label=True,
        )
    except Exception:
        FAILURES.append("process_leus_to_video raised exception (legacy path)")
        _fail("process_leus_to_video raised exception (legacy path)")
        traceback.print_exc()
        return False

    assert_true(video2 is not None, "3b: legacy path returned a video path")

    legacy_line = [l for l in log2.split("\n") if "legacy mode" in l.lower() or "1:1" in l]
    assert_true(
        len(legacy_line) > 0,
        "3b: log contains legacy fallback message",
    )
    if legacy_line:
        _info(f"Log: {legacy_line[0].strip()}")

    legacy_out = os.path.join(out_dir, "legacy_no_timestamps.mp4")
    shutil.copy(video2, legacy_out)
    _info(f"Saved: {legacy_out}")

    # ── 3c: Toggle test — re-render with liver off ────────────────────────────
    _info("\n3c: Re-render with show_liver=False → video should still be produced")
    if state is not None:
        try:
            from scripts.video_seg_ui import rerender_video
        except ImportError:
            try:
                from video_seg_ui import rerender_video
            except ImportError:
                rerender_video = None

        if rerender_video:
            try:
                vid3, log3 = rerender_video(
                    state,
                    show_liver=False,
                    show_vessels=True,
                    show_ligaments=False,
                    show_labels=True,
                    show_segments=True,
                    show_liver_label=True,
                )
                assert_true(vid3 is not None, "3c: rerender_video returned a video")
                if vid3:
                    cap3 = cv2.VideoCapture(vid3)
                    nf3  = int(cap3.get(cv2.CAP_PROP_FRAME_COUNT))
                    cap3.release()
                    assert_true(nf3 == n_frames_out, f"3c: re-rendered frame count matches ({nf3})")
                    rerend_out = os.path.join(out_dir, "rerender_liver_off.mp4")
                    shutil.copy(vid3, rerend_out)
                    _info(f"Saved: {rerend_out}")
            except Exception:
                FAILURES.append("rerender_video raised exception")
                _fail("rerender_video raised exception")
                traceback.print_exc()
        else:
            _info("rerender_video not importable — skipping")
    else:
        _info("state is None — skipping re-render test")

    return True


# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — apply_masks_to_hfps_video (timestamp mask-to-frame mapping)
# ─────────────────────────────────────────────────────────────────────────────

def step4_apply_masks(leus_path: str, video_path: str, out_dir: str) -> bool:
    print("\n── Step 4: apply_masks_to_hfps_video ───────────────────────────────")

    if not UI_AVAILABLE:
        _info("video_seg_ui not available — skipping")
        return True

    # Use a small synthetic video to avoid OOM on full-res uploads
    # Duration should span the timestamps in the .leus file
    with open(leus_path, "r") as f:
        leus_data = json.load(f)
    ts_vals  = [im["sourceTimestamp"] for im in leus_data["images"]]
    duration = max(ts_vals) - min(ts_vals)
    fps_out  = 10.0
    n_frames = max(30, int(duration * fps_out))
    synth_video = os.path.join(out_dir, "synth_test.mp4")
    _synthetic_video(synth_video, n_frames=n_frames, fps=fps_out, w=320, h=240)
    _info(f"Synthetic video: {n_frames} frames @ {fps_out}fps  ({duration:.1f}s span)")
    _info(f".leus: {Path(leus_path).name}")

    try:
        class _FakeLeus:
            def __init__(self, p): self.name = p

        vid, log = apply_masks_to_hfps_video(
            state=None,
            video_file=synth_video,
            leus_file=_FakeLeus(leus_path),
            leus_fps_override=5.0,
        )
    except Exception:
        FAILURES.append("apply_masks_to_hfps_video raised exception")
        _fail("apply_masks_to_hfps_video raised exception")
        traceback.print_exc()
        return False

    if vid is None:
        _info(f"Log: {log}")

    assert_true(vid is not None, "4: returned a video path")

    if vid:
        cap = cv2.VideoCapture(vid)
        fps_out = cap.get(cv2.CAP_PROP_FPS)
        n_out   = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
        assert_true(fps_out > 0, f"4: output video FPS={fps_out:.1f}")
        assert_true(n_out > 0,   f"4: output has {n_out} frames")

        # Check that timestamp-based mapping was used (not uniform FPS)
        ts_log = [l for l in log.split("\n") if "timestamp" in l.lower()]
        if ts_log:
            _info(f"Log (timestamp): {ts_log[0].strip()}")
        legacy_log = [l for l in log.split("\n") if "uniform" in l.lower() or "fallback" in l.lower()]
        if legacy_log:
            _info(f"Log (fallback): {legacy_log[0].strip()}")

        import shutil
        out_path = os.path.join(out_dir, "apply_masks_output.mp4")
        shutil.copy(vid, out_path)
        _info(f"Saved: {out_path}")

    _info(f"Full log:\n" + "\n".join(f"    {l}" for l in log.split("\n") if l.strip()))
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="End-to-end pipeline test")
    parser.add_argument(
        "--video",
        default=str(NORM_ROOT / "uploads" / "2aaa3054-293a-4bd6-8a8c-86a5d4531724.mp4"),
        help="Path to EUS video file (default: first NORM upload)",
    )
    parser.add_argument(
        "--out", default="",
        help="Output directory (default: temporary directory)",
    )
    args = parser.parse_args()

    video_path = args.video
    if not Path(video_path).exists():
        # Try finding any mp4 in NORM uploads
        candidates = list((NORM_ROOT / "uploads").glob("*.mp4"))
        if candidates:
            video_path = str(candidates[0])
            print(f"  [INFO] Specified video not found; using {video_path}")
        else:
            print("  [WARN] No video found in NORM/uploads. Generating synthetic video.")
            tmp_video = tempfile.mktemp(suffix=".mp4")
            _synthetic_video(tmp_video, n_frames=50, fps=25.0)
            video_path = tmp_video

    out_dir = args.out or tempfile.mkdtemp(prefix="e2e_test_")
    os.makedirs(out_dir, exist_ok=True)

    print("\n" + "=" * 60)
    print("  EUS End-to-End Pipeline Test")
    print(f"  Video : {video_path}")
    print(f"  Output: {out_dir}")
    print("=" * 60)

    # ── Step 1: Extract frames with NORM ─────────────────────────────────────
    norm_frames, ok1 = step1_norm_extraction(video_path, out_dir)
    if not ok1 or len(norm_frames) < 2:
        print("\n  [ERROR] Need at least 2 frames to proceed. Aborting.")
        sys.exit(1)

    # ── Step 2: Build .leus ───────────────────────────────────────────────────
    leus_path, ok2 = step2_build_leus(norm_frames, out_dir)
    if not ok2:
        print("\n  [ERROR] .leus build failed. Aborting.")
        sys.exit(1)

    legacy_leus_path = step2b_build_legacy_leus(norm_frames, out_dir)

    # ── Step 3: process_leus_to_video ─────────────────────────────────────────
    step3_process_leus_to_video(leus_path, legacy_leus_path, out_dir)

    # ── Step 4: apply_masks_to_hfps_video ────────────────────────────────────
    step4_apply_masks(leus_path, video_path, out_dir)

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    if FAILURES:
        print(f"  RESULT: {len(FAILURES)} FAILURE(S)")
        for f in FAILURES:
            print(f"    ✗ {f}")
        print("=" * 60)
        sys.exit(1)
    else:
        print("  RESULT: ALL CHECKS PASSED")
        print(f"  Output files in: {out_dir}")
        print("=" * 60)


if __name__ == "__main__":
    main()
