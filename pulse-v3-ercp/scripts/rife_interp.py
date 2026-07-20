"""
rife_interp.py — RIFE frame interpolation utilities for video_seg_ui.py

Wraps the rife-ncnn-vulkan binary (https://github.com/nihui/rife-ncnn-vulkan).

RIFE interpolates the raw EUS pixel frames.  Mask/overlay data (contours,
segment fills) is handled by holding the nearest real frame's annotation for
each synthetic frame — no geometry interpolation.  The updated rendering
pipeline (_render_frame_outlines) re-draws fills and outlines fresh on every
frame, so the visual result is always crisp.

Public API
----------
rife_available(binary)                          → bool
build_interpolated_sequence(frame_jpgs,
    frame_data, n_passes, binary)               → (list[bytes], list[dict])
n_passes_for_ratio(ratio)                       → int
"""

import math
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np


# ── RIFE binary helpers ───────────────────────────────────────────────────────

def rife_available(binary: str) -> bool:
    """
    Return True if the rife-ncnn-vulkan binary is callable.
    We only check that subprocess.run doesn't raise — the exit code for
    --help varies by build (e.g. 0xFFFFFFFF on some Windows builds).
    """
    try:
        subprocess.run(
            [binary, "--help"],
            capture_output=True,
            timeout=15,
        )
        return True
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return False


def _run_rife_pass(in_dir: Path, out_dir: Path, binary: str) -> None:
    """
    Run one RIFE 2× pass: in_dir → out_dir (2× as many frames).
    Raises RuntimeError with stderr on non-zero exit.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [binary, "-i", str(in_dir), "-o", str(out_dir)],
        capture_output=True,
        timeout=600,
    )
    if result.returncode != 0:
        msg = result.stderr.decode(errors="ignore").strip()
        raise RuntimeError(f"rife-ncnn-vulkan failed (exit {result.returncode}): {msg}")


# ── Frame byte helpers ────────────────────────────────────────────────────────

def _jpg_bytes_to_bgr(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def _bgr_to_jpg_bytes(bgr: np.ndarray, quality: int = 92) -> bytes:
    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("cv2.imencode failed")
    return buf.tobytes()


# ── Sequence builder ──────────────────────────────────────────────────────────

def build_interpolated_sequence(
    frame_jpgs: list,
    frame_data: list,
    n_passes: int,
    binary: str,
) -> tuple:
    """
    Upsample frame_jpgs with RIFE (n_passes × 2× passes).

    For each synthetic frame inserted between two real frames, the mask data
    (contours, segment fills) is taken from the nearest real frame — no
    geometry interpolation.  The rendering pipeline re-draws fills and outlines
    on every frame, so results stay visually crisp.

    Parameters
    ----------
    frame_jpgs  : list[bytes]   raw EUS JPEG bytes (no overlays)
    frame_data  : list[dict]    per-frame annotation dicts
    n_passes    : int           number of RIFE 2× passes (1 → 2×, 2 → 4×, …)
    binary      : str           path / name of rife-ncnn-vulkan executable

    Returns
    -------
    (interp_jpgs, interp_fd) — two parallel lists of the same length
    """
    n_real  = len(frame_jpgs)
    factor  = 2 ** n_passes   # total upsampling factor
    n_synth = factor - 1      # synthetic frames inserted between each real pair

    # ── Step 1: RIFE on raw EUS frames ───────────────────────────────────────
    with tempfile.TemporaryDirectory(prefix="rife_") as tmp_root:
        tmp_root = Path(tmp_root)
        in_dir = tmp_root / "pass_0"
        in_dir.mkdir()

        # Write source frames as PNGs (RIFE requires PNG input)
        for i, jpg in enumerate(frame_jpgs):
            bgr = _jpg_bytes_to_bgr(jpg)
            cv2.imwrite(str(in_dir / f"{i:06d}.png"), bgr)

        # Run RIFE passes sequentially; each doubles the frame count
        cur_dir = in_dir
        for p in range(n_passes):
            out_dir = tmp_root / f"pass_{p + 1}"
            _run_rife_pass(cur_dir, out_dir, binary)
            cur_dir = out_dir

        # Read back all sorted PNGs → JPEG bytes
        rife_pngs = sorted(cur_dir.glob("*.png"))
        rife_jpgs = [_bgr_to_jpg_bytes(cv2.imread(str(p))) for p in rife_pngs]

    # ── Step 2: mask data — hold nearest real frame ───────────────────────────
    # RIFE output interleaves real and synthetic frames:
    #   [f0, s1…s(n_synth), f1, s1…s(n_synth), f2, …]
    # For synthetic frames in the first half of the gap → use frame_data[i].
    # For synthetic frames in the second half → use frame_data[i+1].
    # (Midpoint goes to the earlier frame.)
    interp_fd = []
    half = factor // 2  # e.g. 2 for factor=4

    for i in range(n_real):
        interp_fd.append(frame_data[i])          # real frame i
        if i < n_real - 1:
            for k in range(1, n_synth + 1):
                # k=1..n_synth; switch to next real frame's data past midpoint
                fd = frame_data[i] if k <= half else frame_data[i + 1]
                interp_fd.append(fd)

    # Clip to the shorter list in case RIFE rounding differs by 1–2 frames
    min_len = min(len(rife_jpgs), len(interp_fd))
    return rife_jpgs[:min_len], interp_fd[:min_len]


# ── n_passes selection helper (used by video_seg_ui) ─────────────────────────

def n_passes_for_ratio(ratio: float) -> int:
    """
    Minimum number of 2× RIFE passes so that source_fps × 2^n ≥ target_fps.

    ratio 2.0  → 1  (2×  = 2.0)
    ratio 3.0  → 2  (4×  = 4.0 ≥ 3.0)
    ratio 5.0  → 3  (8×  = 8.0 ≥ 5.0)
    """
    return max(1, math.ceil(math.log2(ratio)))
