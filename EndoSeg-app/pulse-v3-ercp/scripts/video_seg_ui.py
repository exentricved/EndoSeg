#!/usr/bin/env python3
"""
video_seg_ui.py — Liver EUS Video Segmentation

Two independent pipelines:

  1. MP4 → annotated MP4 + .leus
     Uses fine-tuned MobileSAM (ML) for liver + classical blob detection for vessels.
     Liver:   green bounding box
     Vessels: orange fill overlay

  2. .leus files → annotated MP4  (NEW: accepts multiple files, merged in upload order)
     Reads masks DIRECTLY from .leus labels — no ML inference.
     Liver (id=1):          RED outline
     Hepatic/Portal Vein (id=3,4): BLUE outline

Requirements:
  pip install opencv-python gradio

Usage:
  python scripts/video_seg_ui.py
"""

import base64, bisect, io, json, subprocess, sys, tempfile, uuid
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))

try:
    import gradio as gr
    HAS_GRADIO = True
except ImportError:
    HAS_GRADIO = False

try:
    import torch
    import torch.nn.functional as F
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

# ── Constants ─────────────────────────────────────────────────────────────────

MODEL_SIZE = 1024

# BGR colours — ML pipeline (existing)
LIVER_BGR  = (59,  197,  34)   # green
VESSEL_BGR = (60,  146, 251)   # orange

# BGR colours — .leus outline pipeline (new)
LIVER_OUTLINE_BGR       = (0,   0, 255)   # red
PORTAL_VEIN_BGR         = (216, 78,  29)  # dark blue  (#1D4ED8)
HEPATIC_VEIN_BGR        = (250, 165,  96) # light blue (#60A5FA)
LIGAMENT_BGR            = (94,  197,  34) # green      (#22C55E)

# .leus label IDs
LIVER_IDS        = {1}     # Liver
LIGAMENT_IDS     = {2}     # Ligaments
PORTAL_VEIN_IDS  = {3}     # Portal Vein
HEPATIC_VEIN_IDS = {4}     # Hepatic Vein
VESSEL_IDS       = PORTAL_VEIN_IDS | HEPATIC_VEIN_IDS  # combined (ML pipeline)
SEGMENT_IDS      = {9, 10, 11, 12, 13, 14, 15, 16}    # Couinaud segments 1–8

# BGR colours for liver segments (App.tsx TIER2A_LABELS hex → BGR)
SEGMENT_BGRS = {
     9: (182,  89, 155),   # Seg 1  #9B59B6 purple
    10: (185, 128,  41),   # Seg 2  #2980B9 blue
    11: ( 96, 174,  39),   # Seg 3  #27AE60 green
    12: ( 18, 156, 243),   # Seg 4  #F39C12 orange
    13: ( 60,  76, 231),   # Seg 5  #E74C3C red
    14: (133, 160,  22),   # Seg 6  #16A085 teal
    15: (173,  68, 142),   # Seg 7  #8E44AD purple
    16: (  0,  84, 211),   # Seg 8  #D35400 orange
}
SEGMENT_NAMES = {
     9: "Seg 1", 10: "Seg 2", 11: "Seg 3", 12: "Seg 4",
    13: "Seg 5", 14: "Seg 6", 15: "Seg 7", 16: "Seg 8",
}
# All outline / label sizes are derived at render time as a % of the short frame
# dimension — no pixel constants needed here.  These are kept only for tests.
SEGMENT_OUTLINE_THICKNESS = 5   # nominal reference value (tests only)
BASE_OUTLINE_THICKNESS    = 3   # nominal reference value (tests only)
_LABEL_UPDATE_INTERVAL    = 15  # only reposition labels every N frames

# Viewport signal assets directory
VIEWPORT_ASSETS_DIR = Path(
    r"C:\Academics\OneDrive - Johns Hopkins\Liver EUS\UI Elements\Viewport signal"
)

# Highlight panel assets
HIGHLIGHT_BASE_PATH = Path(
    r"C:\Academics\OneDrive - Johns Hopkins\Liver EUS\UI Elements\Highlight_base.png"
)
_HIGHLIGHT_TIP = (314, 506)          # cone rotation center (canvas coords)
_HIGHLIGHT_CONE_ANGLE = 30           # cone opening in degrees
_HIGHLIGHT_DESAT = 0.15              # desaturated areas keep 15% saturation

# Segment ID → target angle (degrees, math convention: 0=right, CCW positive)
_SEGMENT_ANGLES = {
     9: 9,     # Seg I
    10: 93,    # Seg II
    11: 64,    # Seg III
    12: 70,    # Seg IV
    13: 8,     # Seg V
    14: 343,   # Seg VI
    15: 343,   # Seg VII
    16: 8,     # Seg VIII
}

# .leus label definitions (must match TIER2A_LABELS in App.tsx)
_LIVER_LABEL  = {"id": 1, "name": "Liver",   "color": "#8B4513"}
_VESSEL_LABEL = {"id": 9, "name": "Vessels", "color": "#F97316"}


# ── Preprocessing (mirrors autoliver_pipeline_ui._eval_preprocess) ─────────────

def _preprocess_frame(frame_bgr: np.ndarray):
    """BGR frame → (6-ch tensor (1,6,1024,1024), resized RGB uint8 (1024,1024,3))"""
    rgb  = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    rgb_r = cv2.resize(rgb, (MODEL_SIZE, MODEL_SIZE), interpolation=cv2.INTER_LINEAR)

    f    = rgb_r.astype(np.float32) / 255.0
    gray = 0.299 * f[:, :, 0] + 0.587 * f[:, :, 1] + 0.114 * f[:, :, 2]
    gy   = np.gradient(gray, axis=0)
    gx   = np.gradient(gray, axis=1)
    mag  = np.sqrt(gx ** 2 + gy ** 2)
    mx   = mag.max()
    sobel = mag / mx if mx > 0 else mag
    xmap  = np.tile(np.linspace(0, 1, MODEL_SIZE, dtype=np.float32), (MODEL_SIZE, 1))
    ymap  = np.tile(np.linspace(0, 1, MODEL_SIZE, dtype=np.float32).reshape(-1, 1), (1, MODEL_SIZE))
    ch    = np.stack([f[:, :, 0], f[:, :, 1], f[:, :, 2], sobel, xmap, ymap], axis=0)
    return torch.from_numpy(ch).unsqueeze(0), rgb_r


# ── ML liver inference ────────────────────────────────────────────────────────

def _infer_liver(model, tensor, device) -> np.ndarray:
    """Returns sigmoid probability map (1024×1024) float32."""
    tensor = tensor.to(device)
    with torch.no_grad():
        img_emb = model.image_encoder(tensor)
        pt_coords = torch.tensor([[[0.5, 0.5]]], dtype=torch.float32, device=device)
        pt_labels = torch.tensor([[1]],           dtype=torch.float32, device=device)
        sparse_emb, dense_emb = model.prompt_encoder(
            points=(pt_coords, pt_labels), boxes=None, masks=None
        )
        pred, _ = model.mask_decoder(
            image_embeddings=img_emb,
            image_pe=model.prompt_encoder.get_dense_pe(),
            sparse_prompt_embeddings=sparse_emb,
            dense_prompt_embeddings=dense_emb,
            multimask_output=False,
        )
        pred_up = F.interpolate(pred, size=(MODEL_SIZE, MODEL_SIZE),
                                mode="bilinear", align_corners=False)
    return torch.sigmoid(pred_up[0, 0]).cpu().numpy().astype(np.float32)


# ── Classical vessel detection ────────────────────────────────────────────────

def _detect_vessels(gray_1024: np.ndarray, liver_bin: np.ndarray) -> list:
    blurred = cv2.GaussianBlur(gray_1024, (15, 15), 0)
    _, dark  = cv2.threshold(blurred, 20, 255, cv2.THRESH_BINARY_INV)

    if liver_bin.any():
        se  = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (60, 60))
        roi = cv2.dilate((liver_bin * 255).astype(np.uint8), se)
        dark = cv2.bitwise_and(dark, roi)
    else:
        b = MODEL_SIZE // 8
        dark[:b, :] = dark[-b:, :] = dark[:, :b] = dark[:, -b:] = 0

    se_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    dark    = cv2.morphologyEx(dark, cv2.MORPH_OPEN, se_open)

    contours, _ = cv2.findContours(dark, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_area = MODEL_SIZE * MODEL_SIZE
    return [c for c in contours if 300 < cv2.contourArea(c) < img_area * 0.10]


# ── Contour helpers ───────────────────────────────────────────────────────────

def _liver_cnts(liver_bin: np.ndarray) -> list:
    """Return liver mask contours in 1024-space (largest first), or []."""
    cnts, _ = cv2.findContours(
        (liver_bin * 255).astype(np.uint8),
        cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
    )
    return sorted(cnts, key=cv2.contourArea, reverse=True) if cnts else []


def _mask_to_cnts(binary_1024: np.ndarray) -> list:
    """Return contours from a 1024×1024 binary mask."""
    cnts, _ = cv2.findContours(
        (binary_1024 * 255).astype(np.uint8),
        cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE,
    )
    return list(cnts)


def _jagged_cnts(binary_1024: np.ndarray, factor: int = 8) -> list:
    """Extract contours at 1/factor resolution for a blocky autosegmented look.

    Downsamples with NEAREST to preserve hard pixel edges, finds contours on the
    low-res mask with CHAIN_APPROX_NONE (every border pixel retained), then scales
    coordinates back up by factor.  factor=8 → 128×128 resolution contours.
    """
    small = cv2.resize(
        (binary_1024 * 255).astype(np.uint8),
        (MODEL_SIZE // factor, MODEL_SIZE // factor),
        interpolation=cv2.INTER_NEAREST,
    )
    cnts, _ = cv2.findContours(small, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    return [(c.astype(np.float32) * factor).astype(np.int32) for c in cnts]


# ── Contour interpolation helpers ─────────────────────────────────────────────

def _resample_contour(cnt: np.ndarray, n: int = 120) -> np.ndarray:
    """Resample a single contour to n uniformly-spaced points (arc-length param)."""
    pts = cnt.reshape(-1, 2).astype(np.float32)
    k = len(pts)
    if k == 0:
        return np.zeros((n, 1, 2), dtype=np.float32)
    if k == 1:
        return np.tile(pts[0], (n, 1)).reshape(n, 1, 2)
    diffs = np.diff(pts, axis=0)
    cum = np.concatenate([[0.0], np.cumsum(np.linalg.norm(diffs, axis=1))])
    total = cum[-1]
    if total < 1e-6:
        return np.tile(pts[0], (n, 1)).reshape(n, 1, 2)
    targets = np.linspace(0.0, total, n)
    out = np.zeros((n, 2), dtype=np.float32)
    for i, t in enumerate(targets):
        idx = min(np.searchsorted(cum, t, side="right") - 1, k - 2)
        seg = cum[idx + 1] - cum[idx]
        a   = (t - cum[idx]) / seg if seg > 1e-9 else 0.0
        out[i] = pts[idx] * (1.0 - a) + pts[idx + 1] * a
    return out.reshape(n, 1, 2)


def _lerp_cnts(cnts_a: list, cnts_b: list, t: float) -> list:
    """Linearly interpolate the largest contour from each list at time t ∈ [0,1]."""
    def _largest(cnts):
        return max(cnts, key=cv2.contourArea) if cnts else None
    ca, cb = _largest(cnts_a), _largest(cnts_b)
    if ca is None and cb is None:
        return []
    if ca is None:
        return [cb]
    if cb is None:
        return [ca]
    ra = _resample_contour(ca, 120)
    rb = _resample_contour(cb, 120)
    # Align starting points: roll rb so its index-0 is spatially closest to ra[0].
    # Without this, different scan-order starting vertices cause the lerp to look
    # like the contour is collapsing/exploding between frames.
    ra_pts = ra.reshape(-1, 2)
    rb_pts = rb.reshape(-1, 2)
    dists  = np.sum((rb_pts - ra_pts[0]) ** 2, axis=1)
    best_k = int(np.argmin(dists))
    if best_k:
        rb_pts = np.roll(rb_pts, -best_k, axis=0)
    return [((ra_pts * (1.0 - t) + rb_pts * t).reshape(120, 1, 2)).astype(np.float32)]


def _lerp_frame_data(fd_a: dict, fd_b: dict, t: float) -> dict:
    """Interpolate all contour fields between two frame_data dicts at time t."""
    result = {
        k: _lerp_cnts(fd_a.get(k, []), fd_b.get(k, []), t)
        for k in ("liver_cnts", "portal_cnts", "hepatic_cnts", "ligament_cnts")
    }
    segs_a = fd_a.get("segment_cnts", {})
    segs_b = fd_b.get("segment_cnts", {})
    result["segment_cnts"] = {
        sid: _lerp_cnts(segs_a.get(sid, []), segs_b.get(sid, []), t)
        for sid in set(segs_a) | set(segs_b)
    }
    if "vessel_cnts" in fd_a or "vessel_cnts" in fd_b:
        result["vessel_cnts"] = _lerp_cnts(
            fd_a.get("vessel_cnts", []), fd_b.get("vessel_cnts", []), t
        )
    return result


# ── Frame rendering — ML pipeline (green/orange) ──────────────────────────────

def _draw_label(img: np.ndarray, text: str, x: int, y: int, color_bgr: tuple,
                scale: float = 0.94, thick: int = 2):
    font  = cv2.FONT_HERSHEY_SIMPLEX
    (tw, th), bl = cv2.getTextSize(text, font, scale, thick)
    y = max(y, th + bl + 4)
    x = min(x, img.shape[1] - tw - 4)
    cv2.rectangle(img, (x - 2, y - th - bl - 2), (x + tw + 2, y + bl), (0, 0, 0), -1)
    cv2.putText(img, text, (x, y), font, scale, color_bgr, thick, cv2.LINE_AA)


_ROMAN = [(1000,"M"),(900,"CM"),(500,"D"),(400,"CD"),(100,"C"),(90,"XC"),
          (50,"L"),(40,"XL"),(10,"X"),(9,"IX"),(5,"V"),(4,"IV"),(1,"I")]

def _to_roman(n: int) -> str:
    result = ""
    for val, sym in _ROMAN:
        while n >= val:
            result += sym
            n -= val
    return result


def _draw_label_centered(img: np.ndarray, text: str, cx: int, cy: int, color_bgr: tuple,
                         scale: float = 0.94, thick: int = 2):
    """Draw a label with its background box centred on (cx, cy)."""
    font  = cv2.FONT_HERSHEY_SIMPLEX
    (tw, th), bl = cv2.getTextSize(text, font, scale, thick)
    x = cx - tw // 2
    y = cy + th // 2
    # clamp to image bounds
    x = max(2, min(x, img.shape[1] - tw - 4))
    y = max(th + bl + 4, min(y, img.shape[0] - bl - 2))
    cv2.rectangle(img, (x - 2, y - th - bl - 2), (x + tw + 2, y + bl), (0, 0, 0), -1)
    cv2.putText(img, text, (x, y), font, scale, color_bgr, thick, cv2.LINE_AA)


def _label_near_boundary(
    img: np.ndarray,
    cnts: list,
    text: str,
    color_bgr: tuple,
    lbl_scale: float,
    lbl_thick: int,
    occupied: list,
    outline_thick: int = 1,
    margin: int = 5,
) -> bool:
    """
    Place a text label tangentially near the contour boundary.

    Samples points around the perimeter of the largest contour, offsets each
    inward (toward the centroid) by at least (box_half_height + outline_thick
    + margin) pixels — so the label box never overlaps the outline edge.
    Picks the topmost candidate that:
      • is fully inside the frame (margin px clearance from all edges)
      • does not overlap any rect already in `occupied`

    On success appends the placed rect to `occupied` and returns True.
    """
    if not cnts:
        return False
    font = cv2.FONT_HERSHEY_SIMPLEX
    (tw, th), bl = cv2.getTextSize(text, font, lbl_scale, lbl_thick)

    largest = max(cnts, key=cv2.contourArea)
    pts = largest.reshape(-1, 2).astype(np.float32)
    M_mom = cv2.moments(largest)
    if M_mom["m00"] == 0:
        return False
    icx = M_mom["m10"] / M_mom["m00"]
    icy = M_mom["m01"] / M_mom["m00"]

    H, W = img.shape[:2]
    box_hw = tw // 2 + 3
    box_hh = (th + bl) // 2 + 3

    # Inset far enough that the label box edge clears the outline by `margin` px.
    inset = box_hh + outline_thick + margin

    n = len(pts)
    step = max(1, n // 32)
    candidates = []
    for i in range(0, n, step):
        bx, by = float(pts[i][0]), float(pts[i][1])
        dx, dy = icx - bx, icy - by
        dist = (dx * dx + dy * dy) ** 0.5 or 1.0
        # Move inward by `inset` px, cap at 90 % toward centroid
        t = min(inset / dist, 0.90)
        candidates.append((int(bx + dx * t), int(by + dy * t)))

    # Prefer topmost positions (smallest cy) for readability
    candidates.sort(key=lambda p: (p[1], p[0]))

    for cx, cy in candidates:
        x1, y1 = cx - box_hw, cy - box_hh
        x2, y2 = cx + box_hw, cy + box_hh
        if x1 < margin or y1 < margin or x2 > W - margin or y2 > H - margin:
            continue
        if any(x2 > ox1 and x1 < ox2 and y2 > oy1 and y1 < oy2
               for ox1, oy1, ox2, oy2 in occupied):
            continue
        occupied.append((x1, y1, x2, y2))
        cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 0), -1)
        cv2.putText(img, text, (cx - tw // 2, cy + th // 2),
                    font, lbl_scale, color_bgr, lbl_thick, cv2.LINE_AA)
        return True
    return False


def _render_frame(
    frame_bgr:      np.ndarray,
    fd:             dict,
    show_liver:     bool,
    show_vessels:   bool,
    show_ligaments: bool,   # unused in ML pipeline
    show_labels:    bool,
) -> np.ndarray:
    liver_cnts_1024  = fd["liver_cnts"]
    vessel_cnts_1024 = fd["vessel_cnts"]
    oh, ow = frame_bgr.shape[:2]
    sx, sy = ow / MODEL_SIZE, oh / MODEL_SIZE
    out    = frame_bgr.copy()

    if show_vessels and vessel_cnts_1024:
        scaled = [(c.astype(np.float32) * [sx, sy]).astype(np.int32)
                  for c in vessel_cnts_1024]
        overlay = out.copy()
        cv2.drawContours(overlay, scaled, -1, VESSEL_BGR, -1)
        cv2.addWeighted(overlay, 0.45, out, 0.55, 0, out)
        cv2.drawContours(out, scaled, -1, VESSEL_BGR, 1)
        if show_labels:
            largest = max(scaled, key=cv2.contourArea)
            M = cv2.moments(largest)
            if M["m00"] > 0:
                cx = int(M["m10"] / M["m00"])
                cy = int(M["m01"] / M["m00"])
                _draw_label(out, "Vessels", cx, cy - 6, VESSEL_BGR)

    if show_liver and liver_cnts_1024:
        scaled = [(c.astype(np.float32) * [sx, sy]).astype(np.int32)
                  for c in liver_cnts_1024]
        overlay = out.copy()
        cv2.drawContours(overlay, scaled, -1, LIVER_BGR, -1)
        cv2.addWeighted(overlay, 0.20, out, 0.80, 0, out)
        cv2.drawContours(out, scaled, -1, LIVER_BGR, 2)
        if show_labels:
            M = cv2.moments(scaled[0])
            if M["m00"] > 0:
                cx = int(M["m10"] / M["m00"])
                cy = int(M["m01"] / M["m00"])
                _draw_label(out, "Liver", cx, cy - 6, LIVER_BGR)

    return out


# ── Frame rendering — .leus outline pipeline (red/blue) ───────────────────────

def _render_frame_outlines(
    frame_bgr:         np.ndarray,
    fd:                dict,
    show_liver:        bool,
    show_vessels:      bool,
    show_ligaments:    bool,
    show_labels:       bool,
    outline_thickness: int = BASE_OUTLINE_THICKNESS,
) -> np.ndarray:
    """
    Draw a faint filled mask for each structure, then a thin outline on top.

    Fill priority (higher overwrites lower):
        vessels (portal + hepatic)  >  liver segments (I–VIII)  >  liver boundary

    Outlines:
        Liver:        red          (LIVER_OUTLINE_BGR)
        Portal Vein:  dark blue    (PORTAL_VEIN_BGR)
        Hepatic Vein: light blue   (HEPATIC_VEIN_BGR)
        Ligaments:    green        (LIGAMENT_BGR)
        Segments 1-8: per-segment colour, Roman numeral near segment edge

    Labels are placed tangentially near the contour boundary and are guaranteed
    not to overlap each other or extend outside the frame (white bg for contrast).
    """
    liver_cnts_1024    = fd["liver_cnts"]
    portal_cnts_1024   = fd["portal_cnts"]
    hepatic_cnts_1024  = fd["hepatic_cnts"]
    ligament_cnts_1024 = fd["ligament_cnts"]
    segment_cnts_1024  = fd.get("segment_cnts", {})
    show_segments      = fd.get("_show_segments", True)
    show_liver_label   = fd.get("_show_liver_label", True)

    oh, ow = frame_bgr.shape[:2]
    sx, sy = ow / MODEL_SIZE, oh / MODEL_SIZE
    out    = frame_bgr.copy()

    ref        = min(oh, ow)
    base_thick = 1
    seg_thick  = 1
    lbl_target = max(12, ref * 0.035)
    lbl_scale  = round(lbl_target / 18.0, 2)
    lbl_thick  = max(1, round(lbl_scale * 2.1))

    def _scale(cnts_1024):
        return [(c.astype(np.float32) * [sx, sy]).astype(np.int32) for c in cnts_1024]

    # ── Faint mask fills ─────────────────────────────────────────────────────
    fill_canvas = np.zeros_like(out)

    if show_liver and liver_cnts_1024:
        cv2.drawContours(fill_canvas, _scale(liver_cnts_1024), -1, LIVER_OUTLINE_BGR, -1)

    if show_segments:
        for seg_id in sorted(segment_cnts_1024):
            cnts = segment_cnts_1024[seg_id]
            if cnts:
                color = SEGMENT_BGRS.get(seg_id, (255, 255, 255))
                cv2.drawContours(fill_canvas, _scale(cnts), -1, color, -1)

    if show_vessels:
        for cnts_1024, color in [
            (portal_cnts_1024,  PORTAL_VEIN_BGR),
            (hepatic_cnts_1024, HEPATIC_VEIN_BGR),
        ]:
            if cnts_1024:
                cv2.drawContours(fill_canvas, _scale(cnts_1024), -1, color, -1)

    fill_mask = np.any(fill_canvas > 0, axis=2)
    if fill_mask.any():
        alpha  = 0.05
        m      = fill_mask[:, :, np.newaxis]
        out_f  = out.astype(np.float32)
        fill_f = fill_canvas.astype(np.float32)
        out = np.where(m, out_f * (1.0 - alpha) + fill_f * alpha, out_f).astype(np.uint8)

    # ── Outlines + tangential labels ─────────────────────────────────────────
    # `occupied` grows as labels are placed; each _label_near_boundary call
    # checks it so no two labels overlap each other or the frame edge.
    occupied: list = []

    def _draw_cnts(cnts, color, label_text, thick=base_thick, draw_label=True):
        if not cnts:
            return
        scaled = _scale(cnts)
        cv2.drawContours(out, scaled, -1, color, thick)
        if show_labels and draw_label:
            _label_near_boundary(out, scaled, label_text, color,
                                 lbl_scale, lbl_thick, occupied,
                                 outline_thick=thick)

    if show_ligaments:
        _draw_cnts(ligament_cnts_1024, LIGAMENT_BGR, "Ligaments")

    if show_vessels:
        _draw_cnts(hepatic_cnts_1024, HEPATIC_VEIN_BGR, "Hepatic Vein")
        _draw_cnts(portal_cnts_1024,  PORTAL_VEIN_BGR,  "Portal Vein")

    if show_segments:
        for seg_id in sorted(segment_cnts_1024):
            cnts = segment_cnts_1024[seg_id]
            if not cnts:
                continue
            color  = SEGMENT_BGRS.get(seg_id, (255, 255, 255))
            roman  = _to_roman(seg_id - 8)   # id 9 → Seg I, id 10 → Seg II …
            scaled = _scale(cnts)
            cv2.drawContours(out, scaled, -1, color, seg_thick)
            if show_labels:
                _label_near_boundary(out, scaled, roman, color,
                                     lbl_scale, lbl_thick, occupied,
                                     outline_thick=seg_thick)

    if show_liver:
        _draw_cnts(liver_cnts_1024, LIVER_OUTLINE_BGR, "Liver",
                   draw_label=show_liver_label)

    return out


# ── Viewport signal video ────────────────────────────────────────────────────

def _load_overlay_bgra(path):
    """Load a PNG as BGRA, creating alpha from white-key if no alpha channel."""
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    if len(img.shape) == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        white_mask = np.all(img > 240, axis=2)
        alpha = np.where(white_mask, 0, 255).astype(np.uint8)
        img = np.dstack([img, alpha])
    return img


def _load_viewport_assets():
    """Load all viewport signal overlay images as BGRA arrays.

    Returns a dict with keys: base, numbers, segments, hepatic, size.
    Returns None if the assets directory does not exist.
    """
    d = VIEWPORT_ASSETS_DIR
    if not d.exists():
        return None

    base = _load_overlay_bgra(d / "BaseImage_original.png")
    numbers = _load_overlay_bgra(d / "Numbers.png")
    # Make number text white for visibility on dark background
    if numbers is not None:
        mask = numbers[:, :, 3] > 0
        numbers[mask, 0] = 255
        numbers[mask, 1] = 255
        numbers[mask, 2] = 255

    segments = {}
    seg_dir = d / "Liver Segments"
    for i in range(1, 9):
        seg_img = _load_overlay_bgra(seg_dir / f"Segment{i}.png")
        if seg_img is not None:
            segments[i] = seg_img
    hepatic = _load_overlay_bgra(seg_dir / "HepaticVein.png")
    portal  = _load_overlay_bgra(seg_dir / "PortalVein.png")

    return {
        "base": base,
        "numbers": numbers,
        "segments": segments,
        "hepatic": hepatic,
        "portal": portal,
        "size": (base.shape[1], base.shape[0]) if base is not None else (1000, 1000),
    }


def _composite_bgra_onto(canvas_bgr, overlay_bgra):
    """Alpha-composite a BGRA overlay onto a BGR canvas in-place."""
    h, w = canvas_bgr.shape[:2]
    oh, ow = overlay_bgra.shape[:2]
    if oh != h or ow != w:
        overlay_bgra = cv2.resize(overlay_bgra, (w, h), interpolation=cv2.INTER_AREA)
    alpha = overlay_bgra[:, :, 3:4].astype(np.float32) / 255.0
    bgr = overlay_bgra[:, :, :3].astype(np.float32)
    canvas_f = canvas_bgr.astype(np.float32)
    canvas_bgr[:] = (canvas_f * (1.0 - alpha) + bgr * alpha).astype(np.uint8)


def _render_viewport_frame(fd, assets):
    """Render a single viewport signal frame based on which labels are active."""
    w, h = assets["size"]
    canvas = np.zeros((h, w, 3), dtype=np.uint8)

    # Layer 1: Base image (always shown)
    if assets["base"] is not None:
        _composite_bgra_onto(canvas, assets["base"])

    # Layer 2: Active segment overlays
    segment_cnts = fd.get("segment_cnts", {})
    for seg_id, cnts in segment_cnts.items():
        if cnts:
            seg_num = seg_id - 8  # id 9 → seg 1, id 10 → seg 2, …
            if seg_num in assets["segments"]:
                _composite_bgra_onto(canvas, assets["segments"][seg_num])

    # Layer 2b: Hepatic vein overlay
    hepatic_cnts = fd.get("hepatic_cnts", [])
    if hepatic_cnts and assets["hepatic"] is not None:
        _composite_bgra_onto(canvas, assets["hepatic"])

    # Layer 2c: Portal vein overlay
    portal_cnts = fd.get("portal_cnts", [])
    if portal_cnts and assets["portal"] is not None:
        _composite_bgra_onto(canvas, assets["portal"])

    # Layer 3: Numbers (always on top for reference)
    if assets["numbers"] is not None:
        _composite_bgra_onto(canvas, assets["numbers"])

    return canvas


def _write_viewport_video(frame_data, out_path, fps, assets,
                          progress_fn=None, p_start=0.0, p_end=1.0):
    """Write the viewport signal video from frame data and overlay assets."""
    w, h = assets["size"]
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(out_path, fourcc, fps, (w, h))
    n = len(frame_data)
    for fi, fd in enumerate(frame_data):
        if progress_fn:
            progress_fn(
                p_start + (fi / n) * (p_end - p_start),
                desc=f"Viewport signal {fi + 1}/{n}",
            )
        frame = _render_viewport_frame(fd, assets)
        writer.write(frame)
    writer.release()


# ── Frame storage helpers ─────────────────────────────────────────────────────

def _frame_to_jpg_bytes(frame_bgr: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".jpg", frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 88])
    if not ok:
        raise RuntimeError("JPEG encode failed")
    return buf.tobytes()


def _jpg_bytes_to_bgr(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


# ── .leus helpers ─────────────────────────────────────────────────────────────

def _decode_mask(mask_url: str) -> np.ndarray:
    """Decode a maskPNG data-URL → binary uint8 array (alpha > 0 = masked)."""
    if "," in mask_url:
        mask_url = mask_url.split(",", 1)[1]
    raw  = base64.b64decode(mask_url)
    pil  = Image.open(io.BytesIO(raw)).convert("RGBA")
    return (np.array(pil)[:, :, 3] > 0).astype(np.uint8)


def _leus_to_frames(leus_path: str) -> tuple:
    """
    Load all frames and per-frame masks from a .leus project file.

    Returns (frames_bgr, liver_masks, portal_masks, hepatic_masks,
             ligament_masks, segment_masks_list, w, h, timestamps).
    Each *_masks[i] is None when no annotation exists for that label on that frame.
    segment_masks_list[i] is a dict {label_id: binary_1024} for each present segment.
    timestamps[i] is float seconds from the original video (None if not stored).
    All masks are resized to MODEL_SIZE×MODEL_SIZE.
    """
    with open(leus_path, "r", encoding="utf-8") as f:
        proj = json.load(f)

    frames             = []
    liver_masks        = []
    portal_masks       = []
    hepatic_masks      = []
    ligament_masks     = []
    segment_masks_list = []
    timestamps         = []
    w = h = 0

    for img_entry in proj.get("images", []):
        url = img_entry.get("baseURL", "")
        if not url:
            continue
        if "," in url:
            url = url.split(",", 1)[1]
        raw = base64.b64decode(url)
        pil = Image.open(io.BytesIO(raw)).convert("RGB")
        bgr = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
        w, h = bgr.shape[1], bgr.shape[0]
        frames.append(bgr)

        ts_val = img_entry.get("sourceTimestamp", None)
        timestamps.append(
            float(ts_val) if isinstance(ts_val, (int, float)) and ts_val >= 0 else None
        )

        liver_bin    = np.zeros((MODEL_SIZE, MODEL_SIZE), dtype=np.uint8)
        portal_bin   = np.zeros((MODEL_SIZE, MODEL_SIZE), dtype=np.uint8)
        hepatic_bin  = np.zeros((MODEL_SIZE, MODEL_SIZE), dtype=np.uint8)
        ligament_bin = np.zeros((MODEL_SIZE, MODEL_SIZE), dtype=np.uint8)
        segment_bins = {}   # {label_id: binary_1024}

        for label in img_entry.get("labels", []):
            label_id = label.get("id")
            mask_url = label.get("maskPNG", "")
            if not mask_url:
                continue
            binary  = _decode_mask(mask_url)
            resized = cv2.resize(binary, (MODEL_SIZE, MODEL_SIZE),
                                 interpolation=cv2.INTER_NEAREST)
            if label_id in LIVER_IDS:
                liver_bin    = np.maximum(liver_bin,    resized)
            elif label_id in PORTAL_VEIN_IDS:
                portal_bin   = np.maximum(portal_bin,   resized)
            elif label_id in HEPATIC_VEIN_IDS:
                hepatic_bin  = np.maximum(hepatic_bin,  resized)
            elif label_id in LIGAMENT_IDS:
                ligament_bin = np.maximum(ligament_bin, resized)
            elif label_id in SEGMENT_IDS:
                prev = segment_bins.get(label_id,
                                        np.zeros((MODEL_SIZE, MODEL_SIZE), dtype=np.uint8))
                segment_bins[label_id] = np.maximum(prev, resized)

        liver_masks.append(liver_bin      if liver_bin.any()    else None)
        portal_masks.append(portal_bin    if portal_bin.any()   else None)
        hepatic_masks.append(hepatic_bin  if hepatic_bin.any()  else None)
        ligament_masks.append(ligament_bin if ligament_bin.any() else None)
        # only keep segments that have at least one masked pixel
        segment_masks_list.append(
            {sid: m for sid, m in segment_bins.items() if m.any()}
        )

    return frames, liver_masks, portal_masks, hepatic_masks, ligament_masks, \
           segment_masks_list, w, h, timestamps


def _mask_to_rgba_b64(binary_1024: np.ndarray, orig_w: int, orig_h: int) -> str:
    resized = cv2.resize(
        (binary_1024 * 255).astype(np.uint8),
        (orig_w, orig_h),
        interpolation=cv2.INTER_NEAREST,
    )
    rgba = np.zeros((orig_h, orig_w, 4), dtype=np.uint8)
    rgba[:, :, :3] = 255
    rgba[:, :,  3] = resized
    pil  = Image.fromarray(rgba, mode="RGBA")
    buf  = io.BytesIO()
    pil.save(buf, format="PNG")
    b64  = base64.b64encode(buf.getvalue()).decode()
    return "data:image/png;base64," + b64


def _frame_to_png_b64(frame_bgr: np.ndarray) -> str:
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)
    buf = io.BytesIO()
    pil.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return "data:image/png;base64," + b64


def _vessels_mask_from_cnts(vessel_cnts: list) -> np.ndarray:
    mask_1024 = np.zeros((MODEL_SIZE, MODEL_SIZE), dtype=np.uint8)
    if vessel_cnts:
        cv2.drawContours(mask_1024, vessel_cnts, -1, 1, -1)
    return mask_1024


def _build_leus(
    frame_jpgs: list,
    frame_data: list,
    orig_w: int,
    orig_h: int,
) -> dict:
    images = []
    for fi, (jpg_bytes, fd) in enumerate(zip(frame_jpgs, frame_data)):
        frame_bgr = _jpg_bytes_to_bgr(jpg_bytes)

        liver_bin = np.zeros((MODEL_SIZE, MODEL_SIZE), dtype=np.uint8)
        if fd["liver_cnts"]:
            cv2.drawContours(liver_bin, fd["liver_cnts"], -1, 1, -1)

        vessel_bin = _vessels_mask_from_cnts(fd["vessel_cnts"])

        images.append({
            "id":     str(uuid.uuid4()),
            "name":   f"frame_{fi + 1:04d}",
            "w":      orig_w,
            "h":      orig_h,
            "baseURL": _frame_to_png_b64(frame_bgr),
            "station": "",
            "labels": [
                {
                    **_LIVER_LABEL,
                    "maskPNG":     _mask_to_rgba_b64(liver_bin,  orig_w, orig_h),
                    "visible":     True,
                    "displayFill": True,
                },
                {
                    **_VESSEL_LABEL,
                    "maskPNG":     _mask_to_rgba_b64(vessel_bin, orig_w, orig_h),
                    "visible":     True,
                    "displayFill": True,
                },
            ],
        })

    return {
        "version":  2,
        "organ":    "liver",
        "modality": "linear-eus",
        "images":   images,
    }


# ── Video rendering ───────────────────────────────────────────────────────────

def _write_video_from_jpgs(
    frame_jpgs:     list,
    frame_data:     list,
    out_path:       str,
    fps:            float,
    orig_w:         int,
    orig_h:         int,
    show_liver:       bool,
    show_vessels:     bool,
    show_labels:      bool,
    show_ligaments:   bool = False,
    show_segments:    bool = True,
    show_liver_label: bool = True,
    render_fn=None,
    progress_fn=None,
    p_start: float = 0.0,
    p_end:   float = 1.0,
):
    """
    render_fn: callable(frame_bgr, fd, show_liver, show_vessels,
                        show_ligaments, show_labels) → frame_bgr
    Defaults to _render_frame (ML pipeline style).
    Per-frame fd is augmented with _frame_idx, _label_pos_cache, _show_segments
    so the outline renderer can smooth label positions across frames.
    """
    if render_fn is None:
        render_fn = _render_frame

    label_pos_cache = {}   # shared across all frames; mutated in-place by render_fn
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(out_path, fourcc, fps, (orig_w, orig_h))
    n = len(frame_jpgs)
    for fi, (jpg_bytes, fd) in enumerate(zip(frame_jpgs, frame_data)):
        if progress_fn:
            progress_fn(
                p_start + (fi / n) * (p_end - p_start),
                desc=f"Rendering {fi + 1}/{n}",
            )
        frame_bgr = _jpg_bytes_to_bgr(jpg_bytes)
        fd_aug = dict(fd)
        fd_aug["_frame_idx"]       = fi
        fd_aug["_label_pos_cache"] = label_pos_cache
        fd_aug["_show_segments"]   = show_segments
        fd_aug["_show_liver_label"] = show_liver_label
        rendered = render_fn(
            frame_bgr, fd_aug,
            show_liver, show_vessels, show_ligaments, show_labels,
        )
        writer.write(rendered)
    writer.release()


# ── H.264 re-encoding ────────────────────────────────────────────────────────

def _to_h264(src: str) -> tuple:
    """
    Re-encode a video to H.264 MP4 using ffmpeg so it plays in browsers.
    Returns (output_path, log_msg).
    If ffmpeg is unavailable the original path is returned with a warning.
    """
    dst = tempfile.mktemp(suffix=".mp4")
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-i", src,
                "-vcodec", "libx264", "-crf", "23", "-preset", "fast",
                "-movflags", "+faststart",
                dst,
            ],
            capture_output=True,
            timeout=600,
        )
        if result.returncode == 0 and Path(dst).stat().st_size > 0:
            return dst, "Re-encoded to H.264 (browser-compatible)."
        else:
            err = result.stderr.decode(errors="ignore").strip().splitlines()
            return src, f"ffmpeg re-encode failed: {err[-1] if err else 'unknown error'}"
    except FileNotFoundError:
        return src, "WARNING: ffmpeg not found — output uses mp4v codec (may not play in browsers)."
    except subprocess.TimeoutExpired:
        return src, "WARNING: ffmpeg timed out — output uses mp4v codec."


# ── Inference loop (ML pipeline) ─────────────────────────────────────────────

def _run_inference_loop(frames_bgr, model, device, threshold, stride,
                        progress_fn, p_start, p_end,
                        preloaded_vessel_masks=None):
    frame_data = []
    frame_jpgs = []
    n = len(frames_bgr)
    last_liver_cnts  = []
    last_vessel_cnts = []

    for fi, frame_bgr in enumerate(frames_bgr):
        if progress_fn:
            progress_fn(
                p_start + (fi / n) * (p_end - p_start),
                desc=f"Processing {fi + 1}/{n}",
            )
        if fi % stride == 0:
            tensor, rgb_r    = _preprocess_frame(frame_bgr)
            prob             = _infer_liver(model, tensor, device)
            liver_bin        = (prob > threshold).astype(np.uint8)
            last_liver_cnts  = _liver_cnts(liver_bin)
            gray_1024        = cv2.cvtColor(rgb_r, cv2.COLOR_RGB2GRAY)
            classical_cnts   = _detect_vessels(gray_1024, liver_bin)

            preloaded = (preloaded_vessel_masks[fi]
                         if preloaded_vessel_masks and preloaded_vessel_masks[fi] is not None
                         else None)
            if preloaded is not None:
                combined_bin = np.zeros((MODEL_SIZE, MODEL_SIZE), dtype=np.uint8)
                if classical_cnts:
                    cv2.drawContours(combined_bin, classical_cnts, -1, 1, -1)
                combined_bin = np.maximum(combined_bin, preloaded)
                extra_cnts, _ = cv2.findContours(combined_bin, cv2.RETR_EXTERNAL,
                                                 cv2.CHAIN_APPROX_SIMPLE)
                last_vessel_cnts = list(extra_cnts)
            else:
                last_vessel_cnts = classical_cnts

        frame_data.append({"liver_cnts":  last_liver_cnts,
                            "vessel_cnts": last_vessel_cnts})
        frame_jpgs.append(_frame_to_jpg_bytes(frame_bgr))

    return frame_data, frame_jpgs


# ── MP4 processing entry point ────────────────────────────────────────────────

def process_video(
    mp4_file,
    leus_file,
    checkpoint_path:  str,
    medsam_path:      str,
    threshold:        float,
    max_frames:       int,
    leus_fps:         float,
    inference_stride: int,
    show_liver:       bool,
    show_vessels:     bool,
    show_labels:      bool,
    progress=gr.Progress() if HAS_GRADIO else None,
):
    if not HAS_TORCH:
        return None, None, None, "ERROR: PyTorch not installed."
    if mp4_file is None and leus_file is None:
        return None, None, None, "No input provided. Upload an MP4 or a .leus file."

    ckpt = Path(checkpoint_path)
    msam = Path(medsam_path)
    if not ckpt.exists():
        return None, None, None, f"ERROR: checkpoint not found: {ckpt}"
    if not msam.exists():
        return None, None, None, f"ERROR: MobileSAM checkpoint not found: {msam}"

    logs = []

    if progress:
        progress(0.0, desc="Loading model...")
    try:
        from autoliver_pipeline_ui import _get_medsam_lite
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        logs.append(f"Device: {device}")
        model = _get_medsam_lite(str(msam))
        state = torch.load(str(ckpt), map_location="cpu", weights_only=False)
        if not isinstance(state, dict):
            state = state.state_dict()
        model.load_state_dict(state, strict=False)
        model.to(device).eval()
        logs.append("Model loaded.")
    except Exception as e:
        return None, None, None, f"ERROR loading model: {e}"

    source = "mp4" if mp4_file is not None else "leus"
    stride            = max(1, int(inference_stride))
    leus_vessel_masks = None

    if source == "mp4":
        video_path = mp4_file if isinstance(mp4_file, str) else mp4_file.name
        cap    = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return None, None, None, f"ERROR: cannot open video: {video_path}"
        fps    = cap.get(cv2.CAP_PROP_FPS) or 25.0
        orig_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        orig_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        n_proc = min(total, int(max_frames)) if int(max_frames) > 0 else total
        logs.append(f"MP4: {orig_w}x{orig_h}  {fps:.1f} fps  "
                    f"{n_proc}/{total} frames  stride={stride}")
        frames_bgr = []
        for _ in range(n_proc):
            ok, f = cap.read()
            if not ok:
                break
            frames_bgr.append(f)
        cap.release()

    else:  # single .leus (legacy tab)
        leus_path = leus_file if isinstance(leus_file, str) else leus_file.name
        fps       = float(leus_fps)
        if progress:
            progress(0.02, desc="Loading .leus frames...")
        try:
            frames_bgr, _, portal_m, hepatic_m, _, _, orig_w, orig_h, _ = _leus_to_frames(leus_path)
            # Merge portal + hepatic for ML pipeline vessel preloading
            leus_vessel_masks = [
                np.maximum(p if p is not None else np.zeros((MODEL_SIZE, MODEL_SIZE), np.uint8),
                           h if h is not None else np.zeros((MODEL_SIZE, MODEL_SIZE), np.uint8))
                if (p is not None or h is not None) else None
                for p, h in zip(portal_m, hepatic_m)
            ]
        except Exception as e:
            return None, None, None, f"ERROR reading .leus: {e}"
        n_proc            = min(len(frames_bgr), int(max_frames)) if int(max_frames) > 0 else len(frames_bgr)
        frames_bgr        = frames_bgr[:n_proc]
        leus_vessel_masks = leus_vessel_masks[:n_proc]
        n_with_masks      = sum(1 for m in leus_vessel_masks if m is not None)
        logs.append(f".leus: {orig_w}x{orig_h}  {fps:.1f} fps  {n_proc} frames  "
                    f"stride={stride}  vessel masks on {n_with_masks} frames")

    if not frames_bgr:
        return None, None, None, "ERROR: no frames extracted."

    frame_data, frame_jpgs = _run_inference_loop(
        frames_bgr, model, device, threshold, stride,
        progress_fn=progress, p_start=0.05, p_end=0.70,
        preloaded_vessel_masks=leus_vessel_masks,
    )
    logs.append(f"Inference done: {len(frame_data)} frames.")

    if progress:
        progress(0.70, desc="Rendering video...")
    out_mp4 = tempfile.mktemp(suffix=".mp4")
    _write_video_from_jpgs(
        frame_jpgs, frame_data, out_mp4, fps, orig_w, orig_h,
        show_liver, show_vessels, show_labels,
        render_fn=_render_frame_outlines,
        progress_fn=progress, p_start=0.70, p_end=0.92,
    )
    out_mp4, h264_log = _to_h264(out_mp4)
    logs.append(h264_log)

    out_leus = None
    if source == "mp4":
        if progress:
            progress(0.92, desc="Building .leus...")
        leus_dict = _build_leus(frame_jpgs, frame_data, orig_w, orig_h)
        out_leus  = tempfile.mktemp(suffix=".leus")
        with open(out_leus, "w", encoding="utf-8") as f:
            json.dump(leus_dict, f)
        logs.append(f".leus ready ({len(frame_data)} frames).")

    if progress:
        progress(1.0, desc="Done.")

    state = {
        "frame_jpgs": frame_jpgs,
        "fps":    fps,
        "orig_w": orig_w,
        "orig_h": orig_h,
        "frame_data": frame_data,
        "mode": "outline",
    }
    return out_mp4, out_leus, state, "\n".join(logs)


# ── .leus → outline video (multi-file, no ML) ─────────────────────────────────

def process_leus_to_video(
    leus_files,
    order_str:        str,
    leus_fps:         float,
    show_liver:       bool,
    show_vessels:     bool,
    show_ligaments:   bool,
    show_labels:      bool,
    show_segments:    bool = True,
    show_liver_label: bool = True,
    progress=gr.Progress() if HAS_GRADIO else None,
):
    """
    Convert one or more .leus files → a single annotated MP4 using mask outlines.

    order_str: comma-separated 1-based indices that set the processing order,
               e.g. "2, 1, 3" processes the second uploaded file first.
               Defaults to upload order when empty.
    Liver mask  → red outline
    Vessel masks (Portal/Hepatic Vein) → blue outline
    No ML inference is performed.
    """
    if not leus_files:
        return None, None, "No .leus files uploaded."

    # Normalise to a list of path strings
    if not isinstance(leus_files, list):
        leus_files = [leus_files]
    paths = [f if isinstance(f, str) else f.name for f in leus_files]

    # Apply user-specified order
    if order_str and order_str.strip():
        try:
            indices = [int(x.strip()) - 1 for x in order_str.split(",") if x.strip()]
            if not indices:
                raise ValueError("empty")
            out_of_range = [i for i in indices if not (0 <= i < len(paths))]
            if out_of_range:
                bad = [i + 1 for i in out_of_range]
                return None, None, (
                    f"ERROR: order index {bad} out of range — "
                    f"valid range is 1–{len(paths)}."
                )
            paths = [paths[i] for i in indices]
        except ValueError:
            return None, None, (
                "ERROR: order must be comma-separated numbers, e.g. '2, 1, 3'."
            )

    logs   = []
    fps    = float(leus_fps)
    orig_w = orig_h = 0

    all_frame_jpgs  = []
    all_frame_data  = []
    all_timestamps  = []
    total_frames    = 0

    for file_idx, leus_path in enumerate(paths):
        if progress:
            progress(
                file_idx / len(paths),
                desc=f"Loading file {file_idx + 1}/{len(paths)}: {Path(leus_path).name}",
            )
        try:
            frames_bgr, liver_masks, portal_masks, hepatic_masks, ligament_masks, \
                segment_masks_list, w, h, file_timestamps = _leus_to_frames(leus_path)
        except Exception as e:
            return None, None, f"ERROR reading {Path(leus_path).name}: {e}"

        if not frames_bgr:
            logs.append(f"  WARNING: {Path(leus_path).name} has no frames — skipped.")
            continue

        # Use dimensions from the first file that has frames
        if orig_w == 0:
            orig_w, orig_h = w, h

        n_liver    = sum(1 for m in liver_masks    if m is not None)
        n_portal   = sum(1 for m in portal_masks   if m is not None)
        n_hepatic  = sum(1 for m in hepatic_masks  if m is not None)
        n_ligament = sum(1 for m in ligament_masks if m is not None)
        n_segs     = sum(1 for sm in segment_masks_list if sm)
        logs.append(
            f"File {file_idx + 1}: {Path(leus_path).name}  "
            f"{w}x{h}  {len(frames_bgr)} frames  "
            f"liver:{n_liver}  portal:{n_portal}  "
            f"hepatic:{n_hepatic}  ligaments:{n_ligament}  "
            f"frames-with-segments:{n_segs}"
        )

        for frame_bgr, lm, pm, hm, lgm, seg_bins, ts in zip(
            frames_bgr, liver_masks, portal_masks, hepatic_masks,
            ligament_masks, segment_masks_list, file_timestamps,
        ):
            all_frame_data.append({
                "liver_cnts":    _jagged_cnts(lm)   if lm  is not None else [],
                "portal_cnts":   _jagged_cnts(pm)   if pm  is not None else [],
                "hepatic_cnts":  _jagged_cnts(hm)   if hm  is not None else [],
                "ligament_cnts": _jagged_cnts(lgm)  if lgm is not None else [],
                "segment_cnts":  {sid: _jagged_cnts(m) for sid, m in seg_bins.items()},
            })
            all_frame_jpgs.append(_frame_to_jpg_bytes(frame_bgr))
            all_timestamps.append(ts)
            total_frames += 1

    if not all_frame_jpgs:
        return None, None, "ERROR: no frames found across all uploaded files."

    logs.append(f"\nAnnotated frames: {total_frames}  FPS: {fps}  "
                f"Resolution: {orig_w}x{orig_h}")

    # ── Timestamp-proportional interpolation ─────────────────────────────────
    # When every frame carries a sourceTimestamp, build a synthetic output
    # timeline at `fps` Hz that spans t_start → t_end of the original video.
    # Masks are linearly interpolated between bracketing annotated frames;
    # the nearest annotated image is used as the background for each output frame.
    # Falls back to 1:1 mapping when timestamps are absent (legacy .leus files).
    has_ts = (
        bool(all_timestamps) and
        all(t is not None for t in all_timestamps) and
        len(all_timestamps) == len(all_frame_data)
    )

    if has_ts:
        order       = sorted(range(len(all_timestamps)), key=lambda i: all_timestamps[i])
        sorted_ts   = [all_timestamps[i]   for i in order]
        sorted_fd   = [all_frame_data[i]   for i in order]
        sorted_jpgs = [all_frame_jpgs[i]   for i in order]
        t_start     = sorted_ts[0]
        t_end       = sorted_ts[-1]
        duration    = t_end - t_start

        if duration < 1e-6:
            has_ts = False   # degenerate: all same timestamp → fall back
        else:
            n_out = max(1, int(round(duration * fps)))
            out_jpgs, out_fd = [], []
            for out_i in range(n_out):
                t      = t_start + out_i / fps
                idx_hi = min(bisect.bisect_right(sorted_ts, t), len(sorted_ts) - 1)
                idx_lo = max(idx_hi - 1, 0)
                span   = sorted_ts[idx_hi] - sorted_ts[idx_lo]
                frac   = (
                    max(0.0, min(1.0, (t - sorted_ts[idx_lo]) / span))
                    if span > 1e-9 else 0.0
                )
                fd_out = (
                    dict(sorted_fd[idx_lo]) if frac < 1e-6
                    else _lerp_frame_data(sorted_fd[idx_lo], sorted_fd[idx_hi], frac)
                )
                bg_idx = idx_lo if frac < 0.5 else idx_hi
                out_jpgs.append(sorted_jpgs[bg_idx])
                out_fd.append(fd_out)
            all_frame_jpgs = out_jpgs
            all_frame_data = out_fd
            total_frames   = len(out_jpgs)
            logs.append(
                f"Timestamp interpolation: {len(sorted_ts)} annotated → "
                f"{total_frames} output frames @ {fps} FPS  ({duration:.2f}s span)"
            )

    if not has_ts:
        logs.append("No timestamps found — 1:1 frame mapping (legacy mode).")

    if progress:
        progress(0.80, desc="Rendering video...")

    out_mp4 = tempfile.mktemp(suffix=".mp4")
    _write_video_from_jpgs(
        all_frame_jpgs, all_frame_data, out_mp4, fps, orig_w, orig_h,
        show_liver, show_vessels, show_labels, show_ligaments,
        show_segments=show_segments,
        show_liver_label=show_liver_label,
        render_fn=_render_frame_outlines,
        progress_fn=progress, p_start=0.80, p_end=0.98,
    )
    out_mp4, h264_log = _to_h264(out_mp4)
    logs.append(h264_log)
    logs.append("Video ready.")

    if progress:
        progress(1.0, desc="Done.")

    state = {
        "frame_jpgs": all_frame_jpgs,
        "fps":    fps,
        "orig_w": orig_w,
        "orig_h": orig_h,
        "frame_data": all_frame_data,
        "mode": "outline",
    }
    return out_mp4, state, "\n".join(logs)


def generate_viewport_video(
    state,
    generate: bool,
    progress=gr.Progress() if HAS_GRADIO else None,
):
    """Generate a viewport signal video from cached frame data.

    Returns (viewport_mp4_path, viewport_mp4_path) — duplicated for video + download outputs.
    Returns (None, None) when skipped.
    """
    if not generate or not state:
        return None, None
    assets = _load_viewport_assets()
    if assets is None:
        return None, None
    if progress:
        progress(0.0, desc="Generating viewport signal…")
    vp_tmp = tempfile.mktemp(suffix=".mp4")
    _write_viewport_video(
        state["frame_data"], vp_tmp, state["fps"], assets,
        progress_fn=progress, p_start=0.05, p_end=0.90,
    )
    if progress:
        progress(0.92, desc="Encoding viewport H.264…")
    vp_mp4, _ = _to_h264(vp_tmp)
    if progress:
        progress(1.0, desc="Viewport done.")
    return vp_mp4, vp_mp4


def process_leus_and_viewport(
    leus_files,
    order_str,
    leus_fps,
    show_liver,
    show_vessels,
    show_ligaments,
    show_labels,
    show_segments,
    show_liver_label,
    generate_viewport,
    progress=gr.Progress() if HAS_GRADIO else None,
):
    """Wrapper: run the main .leus pipeline, then optionally generate viewport video."""
    print(f"[viewport] generate_viewport={generate_viewport}")
    main_video, state, log = process_leus_to_video(
        leus_files, order_str, leus_fps,
        show_liver, show_vessels, show_ligaments, show_labels,
        show_segments, show_liver_label, progress,
    )
    print(f"[viewport] main done — state={'yes' if state else 'None'}, main_video={'yes' if main_video else 'None'}")

    vp_video = None
    if generate_viewport and state:
        assets = _load_viewport_assets()
        print(f"[viewport] assets={'loaded' if assets else 'NOT FOUND'}")
        if assets is not None:
            if progress:
                progress(0.0, desc="Generating viewport signal…")
            vp_tmp = tempfile.mktemp(suffix=".mp4")
            _write_viewport_video(
                state["frame_data"], vp_tmp, state["fps"], assets,
                progress_fn=progress, p_start=0.05, p_end=0.90,
            )
            if progress:
                progress(0.92, desc="Encoding viewport H.264…")
            vp_video, vp_log = _to_h264(vp_tmp)
            log += f"\n{vp_log}\nViewport signal video ready."
            print(f"[viewport] viewport video written: {vp_video}")
            if progress:
                progress(1.0, desc="Done.")
    else:
        print(f"[viewport] SKIPPED — generate_viewport={generate_viewport}, state={'yes' if state else 'None'}")

    return main_video, state, vp_video, log


def _update_file_list(files):
    """
    Called when files are uploaded. Returns:
      - a numbered display string listing filenames
      - a default order string "1, 2, 3, ..."
    Both values feed back into the UI components.
    """
    if not files:
        return "", ""
    paths = [f if isinstance(f, str) else f.name for f in files]
    lines = [f"{i + 1}. {Path(p).name}" for i, p in enumerate(paths)]
    default_order = ", ".join(str(i + 1) for i in range(len(paths)))
    return "\n".join(lines), default_order


def rerender_video(
    state,
    show_liver:       bool,
    show_vessels:     bool,
    show_ligaments:   bool = False,
    show_labels:      bool = True,
    show_segments:    bool = True,
    show_liver_label: bool = True,
):
    """Re-render from cached masks with updated toggle settings."""
    if not state:
        return None, "No cached data — run processing first."
    render_fn = _render_frame_outlines if state.get("mode") == "outline" else _render_frame
    out_mp4 = tempfile.mktemp(suffix=".mp4")
    _write_video_from_jpgs(
        state["frame_jpgs"], state["frame_data"], out_mp4,
        state["fps"], state["orig_w"], state["orig_h"],
        show_liver, show_vessels, show_labels, show_ligaments,
        show_segments=show_segments,
        show_liver_label=show_liver_label,
        render_fn=render_fn,
    )
    out_mp4, _ = _to_h264(out_mp4)
    return out_mp4, "Re-rendered from cache."


def render_variants_from_state(state):
    """Render three targeted variants from cached frame data (no re-inference).

    Returns (liver_mp4, vessels_mp4, segments_mp4, status_msg).
    Each variant has show_labels=False for a clean isolated export.
    """
    if not state:
        return None, None, None, "No cached data — run processing first."

    fps  = state["fps"]
    w, h = state["orig_w"], state["orig_h"]
    jpgs = state["frame_jpgs"]
    fd   = state["frame_data"]

    variants = [
        # (show_liver, show_vessels, show_ligaments, show_segments)
        (True,  False, False, False),   # liver only
        (False, True,  False, False),   # vessels only
        (False, False, False, True),    # segments only
    ]
    paths = []
    for sl, sv, slg, ss in variants:
        tmp = tempfile.mktemp(suffix=".mp4")
        _write_video_from_jpgs(
            jpgs, fd, tmp, fps, w, h,
            show_liver=sl, show_vessels=sv, show_labels=False,
            show_ligaments=slg, show_segments=ss,
            render_fn=_render_frame_outlines,
        )
        tmp, _ = _to_h264(tmp)
        paths.append(tmp)

    return paths[0], paths[1], paths[2], "Exported: liver / vessels / segments."


def _state_summary(state) -> str:
    """One-line description of the cached video, shown in the Interpolate tab."""
    if not state:
        return ""
    return (
        f"{state.get('mode', '?')} mode  |  {state['fps']} FPS  |  "
        f"{len(state['frame_jpgs'])} frames  |  "
        f"{state['orig_w']}×{state['orig_h']}"
    )


def interpolate_from_state(
    state,
    target_fps,
    rife_binary: str,
    progress=gr.Progress() if HAS_GRADIO else None,
):
    """
    Upsample the cached video from its source FPS to target_fps using RIFE.

    Raw EUS frames (no overlays) are sent through rife-ncnn-vulkan; contour
    data is linearly interpolated in parallel so overlays are re-rendered
    cleanly on every synthetic frame.
    """
    import math

    if not state:
        return None, "No cached data — run Tab 1 or Tab 2 first."

    try:
        from rife_interp import rife_available, build_interpolated_sequence, n_passes_for_ratio
    except ImportError as exc:
        return None, f"ERROR: could not import rife_interp.py: {exc}"

    rife_binary = (rife_binary or "rife-ncnn-vulkan").strip()
    if not rife_available(rife_binary):
        return None, (
            f"ERROR: '{rife_binary}' not found or failed to run.\n"
            "Download rife-ncnn-vulkan from  github.com/nihui/rife-ncnn-vulkan/releases\n"
            "and place it in PATH, or enter the full path to the binary."
        )

    source_fps  = float(state["fps"])
    target_fps  = float(target_fps)
    ratio       = target_fps / source_fps
    n_passes    = n_passes_for_ratio(ratio)
    natural_fps = source_fps * (2 ** n_passes)

    logs = [
        f"Source: {len(state['frame_jpgs'])} frames @ {source_fps} FPS",
        f"RIFE {2**n_passes}× ({n_passes} pass{'es' if n_passes > 1 else ''}) "
        f"→ natural {natural_fps} FPS  →  ffmpeg trim to {int(target_fps)} FPS",
    ]

    if progress:
        progress(0.05, desc="Running RIFE…")

    try:
        interp_jpgs, interp_fd = build_interpolated_sequence(
            state["frame_jpgs"], state["frame_data"], n_passes, rife_binary,
        )
    except RuntimeError as exc:
        return None, f"ERROR during RIFE interpolation:\n{exc}"

    logs.append(f"RIFE done: {len(interp_jpgs)} frames generated.")

    if progress:
        progress(0.70, desc="Rendering overlays…")

    render_fn = _render_frame_outlines if state.get("mode") == "outline" else _render_frame
    out_mp4   = tempfile.mktemp(suffix=".mp4")
    _write_video_from_jpgs(
        interp_jpgs, interp_fd, out_mp4, natural_fps,
        state["orig_w"], state["orig_h"],
        show_liver=True, show_vessels=True, show_labels=True,
        show_ligaments=True, show_segments=True,
        render_fn=render_fn,
        progress_fn=progress, p_start=0.70, p_end=0.92,
    )

    if progress:
        progress(0.93, desc=f"Encoding to {int(target_fps)} FPS…")

    # ffmpeg fps filter → exact target FPS + H.264 in one pass
    dst = tempfile.mktemp(suffix=".mp4")
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-i", out_mp4,
                "-vf", f"fps={int(target_fps)}",
                "-vcodec", "libx264", "-crf", "23", "-preset", "fast",
                "-movflags", "+faststart", dst,
            ],
            capture_output=True,
            timeout=600,
        )
        if result.returncode != 0 or not Path(dst).stat().st_size:
            raise RuntimeError(result.stderr.decode(errors="ignore"))
        logs.append(f"ffmpeg fps={int(target_fps)} → output ready.")
    except Exception as exc:
        logs.append(f"WARNING: ffmpeg fps filter failed ({exc}); using {natural_fps} FPS output.")
        dst, enc_log = _to_h264(out_mp4)
        logs.append(enc_log)

    if progress:
        progress(1.0, desc="Done.")

    return dst, "\n".join(logs)


def apply_masks_to_hfps_video(
    state,
    video_file,
    leus_file=None,
    leus_fps_override: float = 11.0,
    progress=gr.Progress() if HAS_GRADIO else None,
):
    """
    Overlay .leus masks onto a high-FPS video with smooth contour interpolation.

    Mask source priority:
        1. leus_file (uploaded directly) — parsed fresh, uses leus_fps_override
        2. state (cached from Tab 1)

    Frame mapping:
        For video frame i at time t = i / video_fps,
        the two bracketing annotation frames are:
            idx_lo = int(t * leus_fps)          (floor)
            idx_hi = min(idx_lo + 1, n_leus-1)  (ceil)
            frac   = (t * leus_fps) - idx_lo    (0.0 → 1.0)
        Contours are lerped at frac using _lerp_frame_data.
    """
    if video_file is None:
        return None, "No video uploaded."

    # ── Resolve annotation source ─────────────────────────────────────────────
    leus_timestamps = None   # set below only when leus_file is parsed

    if leus_file is not None:
        leus_path = leus_file if isinstance(leus_file, str) else leus_file.name
        try:
            _, lm_list, pm_list, hm_list, lgm_list, seg_list, leus_w, leus_h, leus_timestamps = \
                _leus_to_frames(leus_path)
        except Exception as exc:
            return None, f"ERROR reading .leus: {exc}"
        frame_data = []
        for lm, pm, hm, lgm, seg_bins in zip(lm_list, pm_list, hm_list, lgm_list, seg_list):
            frame_data.append({
                "liver_cnts":    _jagged_cnts(lm)   if lm  is not None else [],
                "portal_cnts":   _jagged_cnts(pm)   if pm  is not None else [],
                "hepatic_cnts":  _jagged_cnts(hm)   if hm  is not None else [],
                "ligament_cnts": _jagged_cnts(lgm)  if lgm is not None else [],
                "segment_cnts":  {sid: _jagged_cnts(m) for sid, m in seg_bins.items()},
            })
        leus_fps = float(leus_fps_override)
        mode     = "outline"
    elif state:
        frame_data = state["frame_data"]
        leus_fps   = float(state["fps"])
        mode       = state.get("mode", "outline")
    else:
        return None, "No annotation source — upload a .leus file or run Tab 1 first."

    n_leus = len(frame_data)

    # ── Open the high-FPS video ───────────────────────────────────────────────
    video_path = video_file if isinstance(video_file, str) else video_file.name
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None, f"ERROR: cannot open video: {video_path}"
    video_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    orig_w    = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    orig_h    = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total     = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    logs = [
        f"Video: {orig_w}×{orig_h}  {video_fps:.1f} FPS  {total} frames",
        f"Annotations: {n_leus} frames",
    ]

    if progress:
        progress(0.02, desc="Reading video frames…")

    frames_bgr = []
    for _ in range(total):
        ok, f = cap.read()
        if not ok:
            break
        frames_bgr.append(f)
    cap.release()
    n_video = len(frames_bgr)
    logs.append(f"Loaded {n_video} frames.")

    if progress:
        progress(0.15, desc="Interpolating masks…")

    # ── Build per-video-frame annotation via interpolation ───────────────────
    # When sourceTimestamp is present in every annotation frame, use exact
    # timestamp-based binary search to map each video frame to its correct
    # annotation position. Falls back to the uniform-FPS formula otherwise.
    use_ts = (
        leus_timestamps is not None and
        all(t is not None for t in leus_timestamps) and
        len(leus_timestamps) == n_leus
    )

    mapped_fd = []
    if use_ts:
        ts_order  = sorted(range(n_leus), key=lambda i: leus_timestamps[i])
        sorted_ts = [leus_timestamps[i] for i in ts_order]
        sorted_fd = [frame_data[i]      for i in ts_order]
        for i in range(n_video):
            t      = i / video_fps
            idx_hi = min(bisect.bisect_right(sorted_ts, t), n_leus - 1)
            idx_lo = max(idx_hi - 1, 0)
            span   = sorted_ts[idx_hi] - sorted_ts[idx_lo]
            frac   = (
                max(0.0, min(1.0, (t - sorted_ts[idx_lo]) / span))
                if span > 1e-9 else 0.0
            )
            fd_entry = (
                dict(sorted_fd[idx_lo]) if frac < 1e-6
                else _lerp_frame_data(sorted_fd[idx_lo], sorted_fd[idx_hi], frac)
            )
            fd_entry["_label_fi_override"] = idx_lo * _LABEL_UPDATE_INTERVAL
            mapped_fd.append(fd_entry)
        logs.append("Timestamp-based frame mapping (non-uniform spacing).")
    else:
        for i in range(n_video):
            t_leus  = (i / video_fps) * leus_fps
            idx_lo  = int(t_leus)
            idx_hi  = min(idx_lo + 1, n_leus - 1)
            frac    = t_leus - idx_lo
            if idx_lo >= n_leus - 1 or frac < 1e-6:
                fd_entry = dict(frame_data[min(idx_lo, n_leus - 1)])
            else:
                fd_entry = _lerp_frame_data(frame_data[idx_lo], frame_data[idx_hi], frac)
            fd_entry["_label_fi_override"] = idx_lo * _LABEL_UPDATE_INTERVAL
            mapped_fd.append(fd_entry)
        logs.append(f"Uniform-FPS frame mapping @ {leus_fps:.1f} FPS.")

    if progress:
        progress(0.20, desc="Rendering overlays…")

    frame_jpgs = [_frame_to_jpg_bytes(f) for f in frames_bgr]
    render_fn  = _render_frame_outlines if mode == "outline" else _render_frame
    out_mp4    = tempfile.mktemp(suffix=".mp4")
    _write_video_from_jpgs(
        frame_jpgs, mapped_fd, out_mp4, video_fps,
        orig_w, orig_h,
        show_liver=True, show_vessels=True, show_labels=True,
        show_ligaments=True, show_segments=True,
        render_fn=render_fn,
        progress_fn=progress, p_start=0.20, p_end=0.92,
    )

    if progress:
        progress(0.93, desc="Encoding H.264…")

    out_mp4, enc_log = _to_h264(out_mp4)
    logs.append(enc_log)

    if progress:
        progress(1.0, desc="Done.")

    return out_mp4, "\n".join(logs)


# ── Layout video ─────────────────────────────────────────────────────────────
# Pixel coordinates derived from EUS Layout.pptx at 1920×1080

LAYOUT_W, LAYOUT_H = 1920, 1080
_LAYOUT_BG   = (0, 0, 0)       # pure black
_LAYOUT_BAR  = (30, 30, 30)    # dark grey bar
_LAYOUT_TEXT = (220, 220, 220)  # light grey text
_LAYOUT_ACC  = (180, 180, 180)  # medium grey accent

# (x, y, w, h) pixel rects — updated layout
_LB1 = (400, 103, 1120, 856)   # Panel 1: Segmented EUS video (center)
_LB2 = (0,   103, 400,  380)   # Panel 2: Station image (left top)
_LB3 = (0,   483, 400,  476)   # Panel 3: "Frame contains:" (left bottom, bigger)
_LB4 = (1520, 103, 400,  400)  # Panel 4: Viewport video (right top)
_LB5 = (1520, 503, 400,  456)  # Panel 5: Highlight panel (right bottom)
_LTB = (0,   0,   1920, 103)   # Top bar
_LBB = (0,   959, 1920, 121)   # Bottom bar

STATION_ASSETS_DIR = Path(
    r"C:\Academics\OneDrive - Johns Hopkins\Liver EUS\UI Elements\Stations"
)


def _active_labels(fd: dict) -> list:
    """Return human-readable names of structures present in this frame."""
    labels = []
    if fd.get("liver_cnts"):
        labels.append("Liver")
    if fd.get("portal_cnts"):
        labels.append("Portal Vein")
    if fd.get("hepatic_cnts"):
        labels.append("Hepatic Vein")
    if fd.get("ligament_cnts"):
        labels.append("Ligaments")
    for seg_id in sorted(fd.get("segment_cnts", {})):
        if fd["segment_cnts"][seg_id]:
            labels.append(SEGMENT_NAMES.get(seg_id, f"Seg {seg_id - 8}"))
    return labels


def _build_station_panel(box_w: int, box_h: int, station_name: str = "TG") -> np.ndarray:
    """Render a station panel for the given station (TG or TD)."""
    from PIL import ImageDraw

    panel = np.full((box_h, box_w, 3), _LAYOUT_BG, dtype=np.uint8)

    station_path = STATION_ASSETS_DIR / f"{station_name}.png"
    img = cv2.imread(str(station_path), cv2.IMREAD_UNCHANGED)

    text_reserve = 80
    img_area_h = box_h - text_reserve

    if img is not None:
        ih, iw = img.shape[:2]
        scale = min(box_w / iw, img_area_h / ih) * 1.35
        nw, nh = int(iw * scale), int(ih * scale)
        resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
        ox = max(0, (box_w - nw) // 2)
        oy = max(0, (img_area_h - nh) // 2)
        # Clamp to panel bounds
        paste_w = min(nw, box_w - ox)
        paste_h = min(nh, img_area_h - oy)
        resized = resized[:paste_h, :paste_w]
        if resized.shape[2] == 4:
            roi = panel[oy:oy + paste_h, ox:ox + paste_w]
            alpha = resized[:, :, 3:4].astype(np.float32) / 255.0
            bgr = resized[:, :, :3].astype(np.float32)
            panel[oy:oy + paste_h, ox:ox + paste_w] = (
                roi.astype(np.float32) * (1.0 - alpha) + bgr * alpha
            ).astype(np.uint8)
        else:
            panel[oy:oy + paste_h, ox:ox + paste_w] = resized

    # Render station label with Calibri
    label_map = {"TG": "TRANSGASTRIC", "TD": "TRANSDUODENAL"}
    label_text = label_map.get(station_name, station_name.upper())

    panel_rgb = Image.fromarray(cv2.cvtColor(panel, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(panel_rgb)
    font = _get_calibri(28)
    text_rgb = (_LAYOUT_TEXT[2], _LAYOUT_TEXT[1], _LAYOUT_TEXT[0])

    for i, line in enumerate([label_text, "STATION"]):
        bbox = draw.textbbox((0, 0), line, font=font)
        tw = bbox[2] - bbox[0]
        tx = (box_w - tw) // 2
        ty = img_area_h + 8 + i * 34
        draw.text((tx, ty), line, font=font, fill=text_rgb)

    return cv2.cvtColor(np.array(panel_rgb), cv2.COLOR_RGB2BGR)


def _get_calibri(size: int):
    """Load Calibri TrueType font at given size."""
    import os
    font_path = os.path.join(os.environ.get("WINDIR", "C:/Windows"),
                             "Fonts", "calibri.ttf")
    try:
        from PIL import ImageFont
        return ImageFont.truetype(font_path, size)
    except Exception:
        from PIL import ImageFont
        return ImageFont.load_default()


def _build_text_panel(labels: list, box_w: int, box_h: int) -> np.ndarray:
    """Render the 'Frame contains:' panel for one frame using Calibri (2x size)."""
    from PIL import ImageDraw

    panel_rgb = Image.new("RGB", (box_w, box_h),
                          (_LAYOUT_BG[2], _LAYOUT_BG[1], _LAYOUT_BG[0]))
    draw = ImageDraw.Draw(panel_rgb)

    header_font = _get_calibri(42)    # 2x (was 21)
    item_font   = _get_calibri(36)    # 2x (was 18)
    acc_rgb  = (_LAYOUT_ACC[2], _LAYOUT_ACC[1], _LAYOUT_ACC[0])
    text_rgb = (_LAYOUT_TEXT[2], _LAYOUT_TEXT[1], _LAYOUT_TEXT[0])
    muted_rgb = (152, 120, 90)

    draw.text((16, 12), "Frame contains:", font=header_font, fill=acc_rgb)

    if not labels:
        draw.text((24, 64), "(none)", font=item_font, fill=muted_rgb)
        return cv2.cvtColor(np.array(panel_rgb), cv2.COLOR_RGB2BGR)

    y = 68
    for lbl in labels:
        if y + 44 > box_h - 8:
            break
        draw.text((24, y), f"\u2022  {lbl}", font=item_font, fill=text_rgb)
        y += 48

    return cv2.cvtColor(np.array(panel_rgb), cv2.COLOR_RGB2BGR)


# ── Highlight panel (Panel 5) ────────────────────────────────────────────────

def _load_highlight_base():
    """Load the liver cross-section base image (cached). Returns BGR numpy array."""
    if not HIGHLIGHT_BASE_PATH.exists():
        return None
    img = cv2.imread(str(HIGHLIGHT_BASE_PATH), cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    # Convert RGBA → BGR with black background
    if img.shape[2] == 4:
        alpha = img[:, :, 3:4].astype(np.float32) / 255.0
        bgr = img[:, :, :3].astype(np.float32)
        img = (bgr * alpha).astype(np.uint8)
    return img


def _make_cone_mask(size: int, tip: tuple, angle_deg: float,
                    opening_deg: float = 50) -> np.ndarray:
    """Generate a cone-shaped mask (white = highlighted) on a black background.

    Args:
        size: image dimension (square)
        tip: (x, y) cone tip position
        angle_deg: direction the cone points (0=right, CCW positive, math convention)
        opening_deg: total opening angle of the cone
    """
    import math
    mask = np.zeros((size, size), dtype=np.uint8)

    half = opening_deg / 2.0
    # Convert math angle to image angle (y-axis flipped)
    img_angle = -angle_deg

    # Build a triangle from tip to two far points
    reach = size * 2  # long enough to go off-canvas
    a1 = math.radians(img_angle - half)
    a2 = math.radians(img_angle + half)

    p1 = (int(tip[0] + reach * math.cos(a1)), int(tip[1] + reach * math.sin(a1)))
    p2 = (int(tip[0] + reach * math.cos(a2)), int(tip[1] + reach * math.sin(a2)))

    pts = np.array([tip, p1, p2], dtype=np.int32)
    cv2.fillPoly(mask, [pts], 255)
    return mask


def _dominant_segment_angle(fd: dict) -> float | None:
    """Return the target angle for the dominant (largest area) segment, or None."""
    segment_cnts = fd.get("segment_cnts", {})
    if not segment_cnts:
        return None

    best_id, best_area = None, 0
    for seg_id, cnts in segment_cnts.items():
        if not cnts:
            continue
        area = sum(cv2.contourArea(np.array(c, dtype=np.int32)) for c in cnts)
        if area > best_area:
            best_area = area
            best_id = seg_id

    if best_id is None or best_id not in _SEGMENT_ANGLES:
        return None
    return _SEGMENT_ANGLES[best_id]


# Segment ID → Roman numeral label text and position (in 1000×1000 base coords)
_SEGMENT_LABELS = {
     9: ("I",       (536, 470)),
    10: ("II",      (306, 321)),
    11: ("III",     (467, 195)),
    12: ("IV",      (676, 207)),
    13: ("V,VIII",  (757, 446)),  # V grouped with VIII
    14: ("VI, VII", (799, 652)),  # VI grouped with VII
    15: ("VI, VII", (799, 652)),  # VII → same label as VI
    16: ("V,VIII",  (757, 446)),  # VIII → same label as V
}


def _build_highlight_panel(base_bgr: np.ndarray, angle: float | None,
                           active_seg_ids: set,
                           box_w: int, box_h: int) -> np.ndarray:
    """Render the highlight panel: desaturated liver with cone spotlight.

    If angle is None (no segments), returns fully desaturated image.
    Active segment labels are drawn in bright white regardless of cone.
    Aspect-ratio fit on black background (no stretching).
    """
    from PIL import ImageDraw, ImageFont
    import os

    h, w = base_bgr.shape[:2]

    # Create desaturated version
    hsv = cv2.cvtColor(base_bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[:, :, 1] *= _HIGHLIGHT_DESAT   # reduce saturation
    hsv[:, :, 2] *= 0.6                # darken
    desat = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)

    if angle is not None:
        # Build cone mask and blend
        cone = _make_cone_mask(max(h, w), _HIGHLIGHT_TIP, angle, _HIGHLIGHT_CONE_ANGLE)
        cone = cone[:h, :w]  # crop to image size

        # Smooth the cone edges
        cone = cv2.GaussianBlur(cone, (21, 21), 0)
        alpha = cone.astype(np.float32) / 255.0
        alpha = alpha[:, :, np.newaxis]

        # Blend: highlighted (original) where cone is white, desaturated elsewhere
        result = (base_bgr.astype(np.float32) * alpha +
                  desat.astype(np.float32) * (1.0 - alpha)).astype(np.uint8)
    else:
        result = desat

    # Aspect-ratio fit onto black panel (no squishing)
    scale = min(box_w / w, box_h / h) * 0.90  # slight padding
    nw, nh = int(w * scale), int(h * scale)
    resized = cv2.resize(result, (nw, nh), interpolation=cv2.INTER_AREA)
    panel = np.zeros((box_h, box_w, 3), dtype=np.uint8)
    ox = (box_w - nw) // 2
    oy = (box_h - nh) // 2
    panel[oy:oy + nh, ox:ox + nw] = resized

    # Draw bright white labels for active segments
    if active_seg_ids:
        panel_pil = Image.fromarray(cv2.cvtColor(panel, cv2.COLOR_BGR2RGB))
        draw = ImageDraw.Draw(panel_pil)
        font_path = os.path.join(os.environ.get("WINDIR", "C:/Windows"),
                                 "Fonts", "calibrib.ttf")
        try:
            font = ImageFont.truetype(font_path, max(12, int(52 * scale)))
        except Exception:
            font = _get_calibri(max(12, int(52 * scale)))

        drawn = set()  # avoid drawing the same label twice (V/VIII, VI/VII share)
        for seg_id in active_seg_ids:
            info = _SEGMENT_LABELS.get(seg_id)
            if not info or info[0] in drawn:
                continue
            text, (cx, cy) = info
            # Convert base coords → panel coords
            px = ox + int(cx * scale)
            py = oy + int(cy * scale)
            bbox = draw.textbbox((0, 0), text, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            draw.text((px - tw // 2, py - th // 2), text,
                      font=font, fill=(255, 255, 255))
            drawn.add(text)

        panel = cv2.cvtColor(np.array(panel_pil), cv2.COLOR_RGB2BGR)

    return panel


def generate_layout_video(
    state,
    progress=gr.Progress() if HAS_GRADIO else None,
):
    """Compose a 1920x1080 layout video with 5 panels."""
    if not state:
        return None, "No cached data — run the .leus tab first."

    from PIL import ImageDraw

    vp_assets = _load_viewport_assets()
    highlight_base = _load_highlight_base()

    # Pre-render both station panels
    station_tg = _build_station_panel(_LB2[2], _LB2[3], "TG")
    station_td = _build_station_panel(_LB2[2], _LB2[3], "TD")

    # Top bar with title (Calibri, 2x size)
    top_bar = np.full((_LTB[3], _LTB[2], 3), _LAYOUT_BAR, dtype=np.uint8)
    top_pil = Image.fromarray(cv2.cvtColor(top_bar, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(top_pil)
    title_font = _get_calibri(48)
    text_rgb = (_LAYOUT_TEXT[2], _LAYOUT_TEXT[1], _LAYOUT_TEXT[0])
    draw.text((24, 28), "Liver EUS Video Segmentation", font=title_font, fill=text_rgb)
    top_bar = cv2.cvtColor(np.array(top_pil), cv2.COLOR_RGB2BGR)

    # Bottom bar (empty)
    bot_bar = np.full((_LBB[3], _LBB[2], 3), _LAYOUT_BAR, dtype=np.uint8)

    frame_jpgs = state["frame_jpgs"]
    frame_data = state["frame_data"]
    fps = state["fps"]
    n = len(frame_jpgs)
    # TD station shown at 20%–35% and last 20% (80%–100%), TG elsewhere
    td_start1 = int(n * 0.20)
    td_end1   = int(n * 0.35)
    td_start2 = int(n * 0.80)

    out_mp4 = tempfile.mktemp(suffix=".mp4")
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(out_mp4, fourcc, fps, (LAYOUT_W, LAYOUT_H))

    for fi in range(n):
        if progress:
            progress(fi / n, desc=f"Layout {fi + 1}/{n}")

        canvas = np.full((LAYOUT_H, LAYOUT_W, 3), _LAYOUT_BG, dtype=np.uint8)

        # Top & bottom bars
        x, y, w, h = _LTB
        canvas[y:y + h, x:x + w] = top_bar
        x, y, w, h = _LBB
        canvas[y:y + h, x:x + w] = bot_bar

        # Panel 1: segmented EUS — aspect-ratio fit, centered
        fd = dict(frame_data[fi])
        fd["_show_segments"] = True
        fd["_show_liver_label"] = True
        eus_bgr = _jpg_bytes_to_bgr(frame_jpgs[fi])
        eus_out = _render_frame_outlines(eus_bgr, fd, True, True, True, False)
        x, y, w, h = _LB1
        eh, ew = eus_out.shape[:2]
        scale = min(w / ew, h / eh)
        nw, nh = int(ew * scale), int(eh * scale)
        resized = cv2.resize(eus_out, (nw, nh), interpolation=cv2.INTER_AREA)
        ox = x + (w - nw) // 2
        oy = y + (h - nh) // 2
        canvas[oy:oy + nh, ox:ox + nw] = resized

        # Panel 2: station — TD at 20%-35% and 80%-100%, TG elsewhere
        x, y, w, h = _LB2
        use_td = (td_start1 <= fi < td_end1) or (fi >= td_start2)
        canvas[y:y + h, x:x + w] = station_td if use_td else station_tg

        # Panel 3: "Frame contains:" (left bottom, bigger text)
        labels = _active_labels(fd)
        x, y, w, h = _LB3
        canvas[y:y + h, x:x + w] = _build_text_panel(labels, w, h)

        # Panel 4: viewport (30% zoom, center crop)
        if vp_assets:
            x, y, w, h = _LB4
            vp_frame = _render_viewport_frame(fd, vp_assets)
            vh, vw = vp_frame.shape[:2]
            crop = 0.30
            cx, cy = vw // 2, vh // 2
            cw, ch = int(vw * (1.0 - crop)), int(vh * (1.0 - crop))
            vp_frame = vp_frame[cy - ch // 2:cy + ch // 2,
                                cx - cw // 2:cx + cw // 2]
            canvas[y:y + h, x:x + w] = cv2.resize(vp_frame, (w, h),
                                                    interpolation=cv2.INTER_AREA)

        # Panel 5: highlight (liver cross-section with rotating cone)
        if highlight_base is not None:
            angle = _dominant_segment_angle(fd)
            active_segs = {sid for sid, cnts in fd.get("segment_cnts", {}).items() if cnts}
            x, y, w, h = _LB5
            canvas[y:y + h, x:x + w] = _build_highlight_panel(
                highlight_base, angle, active_segs, w, h)

        # No borders — clean seamless layout

        writer.write(canvas)

    writer.release()
    out_mp4, enc_log = _to_h264(out_mp4)

    if progress:
        progress(1.0, desc="Done.")

    return out_mp4, f"Layout video: {n} frames @ {fps} FPS.\n{enc_log}"


# ── Gradio UI ─────────────────────────────────────────────────────────────────

_CSS = """
/* ── Video Seg UI — Dark Theme ──────────────────────────────────────── */

/* Force Gradio dark-mode CSS variables */
:root, .light, html {
  --body-background-fill:         #0d1520 !important;
  --body-text-color:              #e4e9f0 !important;
  --background-fill-primary:      #1a2436 !important;
  --background-fill-secondary:    #0d1520 !important;
  --border-color-primary:         #1e2d40 !important;
  --border-color-accent:          #0f9297 !important;
  --color-accent:                 #0f9297 !important;
  --color-accent-soft:            #0e2d1f !important;
  --link-text-color:              #0f9297 !important;
  --link-text-color-hover:        #14adb3 !important;
  --link-text-color-visited:      #0f9297 !important;
  --block-background-fill:        #1a2436 !important;
  --block-border-color:           #1e2d40 !important;
  --block-label-background-fill:  #0d1520 !important;
  --block-label-text-color:       #e4e9f0 !important;
  --block-title-text-color:       #e4e9f0 !important;
  --block-info-text-color:        #5a7898 !important;
  --input-background-fill:        #1a2436 !important;
  --input-border-color:           #1e2d40 !important;
  --input-text-color:             #e4e9f0 !important;
  --input-placeholder-color:      #5a7898 !important;
  --button-primary-background-fill:       #0f9297 !important;
  --button-primary-background-fill-hover: #0a7a7f !important;
  --button-primary-text-color:    #ffffff !important;
  --button-secondary-background-fill:       #1e2d40 !important;
  --button-secondary-background-fill-hover: #263a52 !important;
  --button-secondary-text-color:  #e4e9f0 !important;
  --button-secondary-border-color:#1e2d40 !important;
  --table-even-background-fill:   #1a2436 !important;
  --table-odd-background-fill:    #0d1520 !important;
  --table-row-focus:              #1e2d40 !important;
  --stat-background-fill:         #1a2436 !important;
  --slider-color:                 #0f9297 !important;
  --checkbox-background-color:    #1a2436 !important;
  --checkbox-background-color-selected: #0f9297 !important;
  --checkbox-border-color:        #1e2d40 !important;
  --checkbox-label-background-fill: #1a2436 !important;
  --checkbox-label-text-color:    #e4e9f0 !important;
  --section-header-text-color:    #e4e9f0 !important;
  --prose-text-color:             #e4e9f0 !important;
  --prose-header-text-color:      #e4e9f0 !important;
}

/* Page & container */
html, body { background: #0d1520 !important; color: #e4e9f0 !important; }
.gradio-container { background: #0d1520 !important; color: #e4e9f0 !important; }
footer { display: none !important; }

/* All text */
p, span, label, div, h1, h2, h3, h4, small, strong, em {
  color: #e4e9f0 !important;
}
.prose, .prose p, .prose li, .prose h1, .prose h2, .prose h3 {
  color: #e4e9f0 !important;
}

/* Panels / blocks */
.block, .form, .gap, .panel, .wrap {
  background: #1a2436 !important;
  border-color: #1e2d40 !important;
}

/* Inputs & textareas */
input, textarea, select {
  background: #1a2436 !important;
  border-color: #1e2d40 !important;
  color: #e4e9f0 !important;
}
input::placeholder, textarea::placeholder {
  color: #5a7898 !important;
}

/* Tab nav bar */
.tab-nav, div[class*="tab-nav"] {
  background: #0d1520 !important;
  border-bottom: 1px solid #1e2d40 !important;
}

/* Default tab — muted */
.tab-nav button, div[class*="tab-nav"] button {
  background: transparent !important;
  color: #5a7898 !important;
  border-radius: 6px !important;
  font-weight: 500 !important;
  transition: background 0.15s, color 0.15s !important;
}

/* Hover tab */
.tab-nav button:not(.selected):hover,
div[class*="tab-nav"] button:not(.selected):hover {
  background: #1e2d40 !important;
  color: #e4e9f0 !important;
}

/* Selected tab */
.tab-nav button.selected, div[class*="tab-nav"] button.selected {
  background: #1a2436 !important;
  color: #e4e9f0 !important;
  border-bottom: 2px solid #0f9297 !important;
  box-shadow: none !important;
}

/* Primary buttons */
button.primary, .gr-button-primary, button[class*="primary"] {
  background: #0f9297 !important;
  border-color: #0f9297 !important;
  color: #ffffff !important;
}
button.primary:hover, .gr-button-primary:hover, button[class*="primary"]:hover {
  background: #0a7a7f !important;
  border-color: #0a7a7f !important;
}

/* Secondary / default buttons */
button:not([class*="primary"]) {
  background: #1e2d40 !important;
  border-color: #1e2d40 !important;
  color: #e4e9f0 !important;
}
button:not([class*="primary"]):hover {
  background: #263a52 !important;
}

/* Sliders */
input[type="range"] {
  accent-color: #0f9297 !important;
}

/* Checkboxes */
input[type="checkbox"] {
  accent-color: #0f9297 !important;
}
"""


def build_ui():
    if not HAS_GRADIO:
        print("Gradio not installed.  Run: pip install gradio")
        sys.exit(1)

    with gr.Blocks(title="Liver EUS Video Segmentation") as demo:
        gr.Markdown("# Liver EUS Video Segmentation")

        cached_state = gr.State(None)

        # ── Tab 1: .leus → Outline Video (primary new pipeline) ───────────────
        with gr.Tab(".leus → Outline Video"):
            gr.Markdown(
                "Upload one or **multiple** `.leus` files. Masks are read directly "
                "from the annotation labels — no ML inference required.\n\n"
                "After upload, the files are listed with numbers. "
                "Edit the **Order** field to change the sequence (e.g. `2, 1, 3`).\n\n"
                "**Liver** → red outline  |  "
                "**Hepatic / Portal Vein** → blue outline"
            )

            with gr.Row():
                with gr.Column(scale=1):
                    leus_multi_in = gr.File(
                        label=".leus files (select multiple)",
                        file_types=[".leus"],
                        file_count="multiple",
                    )

                    with gr.Group():
                        gr.Markdown("**File order**")
                        file_list_display = gr.Textbox(
                            label="Uploaded files",
                            lines=4,
                            interactive=False,
                            placeholder="Upload .leus files above to see them listed here.",
                        )
                        order_input = gr.Textbox(
                            label="Order (comma-separated indices, e.g. '2, 1, 3')",
                            lines=1,
                            placeholder="e.g. 2, 1, 3 — leave blank for upload order",
                        )

                    with gr.Group():
                        gr.Markdown("**Options**")
                        with gr.Row():
                            leus_fps_s2 = gr.Slider(
                                label="Output FPS",
                                minimum=1, maximum=30, step=1, value=5,
                            )
                        with gr.Row():
                            show_liver_cb2       = gr.Checkbox(label="Liver outline",      value=True)
                            show_vessels_cb2     = gr.Checkbox(label="Vessel outlines",     value=True)
                            show_ligaments_cb2   = gr.Checkbox(label="Ligament outlines",   value=True)
                            show_labels_cb2      = gr.Checkbox(label="Structure labels",     value=True)
                            show_liver_label_cb2 = gr.Checkbox(label="Liver label",          value=True)
                        with gr.Row():
                            show_segments_cb2  = gr.Checkbox(label="Segment outlines (I–VIII)", value=True)
                        with gr.Row():
                            generate_viewport_cb = gr.Checkbox(
                                label="Generate viewport signal video",
                                value=True,
                                info="Renders a side video showing which liver segments / vessels are visible",
                            )
                        gr.Markdown(
                            "<small>Portal Vein — dark blue &nbsp;|&nbsp; "
                            "Hepatic Vein — light blue &nbsp;|&nbsp; "
                            "Ligaments — green &nbsp;|&nbsp; "
                            "Liver — red &nbsp;|&nbsp; "
                            "Segments — per-segment colour</small>"
                        )

                    with gr.Row():
                        process_leus_btn = gr.Button("Build Outline Video", variant="primary")
                        rerender_btn2    = gr.Button("Re-render")

                    with gr.Row():
                        export_variants_btn = gr.Button("Export Variants (liver / vessels / segments)")

                    log_out2 = gr.Textbox(label="Log", lines=8, interactive=False)

                with gr.Column(scale=1):
                    video_out2 = gr.Video(label="Outline output", autoplay=True)
                    mp4_dl2    = gr.File(label="Download MP4", visible=True)
                    with gr.Row():
                        liver_dl2    = gr.File(label="Liver only",    visible=False)
                        vessels_dl2  = gr.File(label="Vessels only",  visible=False)
                        segments_dl2 = gr.File(label="Segments only", visible=False)
                    gr.Markdown("---")
                    viewport_video_out = gr.Video(label="Viewport signal", autoplay=True)
                    viewport_dl        = gr.File(label="Download viewport MP4", visible=True)

            # Populate file list + default order whenever files change
            leus_multi_in.change(
                fn=_update_file_list,
                inputs=[leus_multi_in],
                outputs=[file_list_display, order_input],
            )

            process_leus_btn.click(
                process_leus_and_viewport,
                inputs=[
                    leus_multi_in,
                    order_input,
                    leus_fps_s2,
                    show_liver_cb2, show_vessels_cb2, show_ligaments_cb2,
                    show_labels_cb2, show_segments_cb2, show_liver_label_cb2,
                    generate_viewport_cb,
                ],
                outputs=[video_out2, cached_state, viewport_video_out, log_out2],
            ).then(
                fn=lambda v, vp: (v, vp),
                inputs=[video_out2, viewport_video_out],
                outputs=[mp4_dl2, viewport_dl],
            )

            _tab2_rerender_inputs = [
                cached_state,
                show_liver_cb2, show_vessels_cb2, show_ligaments_cb2,
                show_labels_cb2, show_segments_cb2, show_liver_label_cb2,
            ]

            rerender_btn2.click(
                rerender_video,
                inputs=_tab2_rerender_inputs,
                outputs=[video_out2, log_out2],
            ).then(
                fn=lambda v: v,
                inputs=[video_out2],
                outputs=[mp4_dl2],
            )

            for _cb in [show_liver_cb2, show_vessels_cb2, show_ligaments_cb2,
                        show_labels_cb2, show_segments_cb2, show_liver_label_cb2]:
                _cb.change(
                    rerender_video,
                    inputs=_tab2_rerender_inputs,
                    outputs=[video_out2, log_out2],
                ).then(
                    fn=lambda v: v,
                    inputs=[video_out2],
                    outputs=[mp4_dl2],
                )

            export_variants_btn.click(
                render_variants_from_state,
                inputs=[cached_state],
                outputs=[liver_dl2, vessels_dl2, segments_dl2, log_out2],
            ).then(
                fn=lambda a, b, c: (
                    gr.update(value=a, visible=a is not None),
                    gr.update(value=b, visible=b is not None),
                    gr.update(value=c, visible=c is not None),
                ),
                inputs=[liver_dl2, vessels_dl2, segments_dl2],
                outputs=[liver_dl2, vessels_dl2, segments_dl2],
            )

        # ── Tab 2: MP4 → ML Segmentation (existing pipeline) ──────────────────
        with gr.Tab("MP4 → ML Segmentation"):
            gr.Markdown(
                "Run the fine-tuned MobileSAM model on an MP4 video.\n\n"
                "**Liver** — green bounding box (ML)  |  "
                "**Vessels** — orange fill (classical blob detection)\n\n"
                "Also accepts a single `.leus` file to augment vessel detection."
            )

            with gr.Row():
                with gr.Column(scale=1):

                    with gr.Tabs():
                        with gr.Tab("MP4 input"):
                            mp4_in = gr.Video(label="Input MP4")
                        with gr.Tab(".leus input"):
                            leus_in = gr.File(
                                label=".leus project file",
                                file_types=[".leus"],
                            )

                    with gr.Group():
                        gr.Markdown("**Model checkpoints**")
                        ckpt_t = gr.Textbox(
                            label="Fine-tuned checkpoint",
                            value="checkpoints/best_checkpoint.pth",
                        )
                        msam_t = gr.Textbox(
                            label="MobileSAM base checkpoint",
                            value="checkpoints/mobile_sam.pt",
                        )

                    with gr.Group():
                        gr.Markdown("**Options**")
                        with gr.Row():
                            thresh_s = gr.Slider(
                                label="Liver threshold",
                                minimum=0.30, maximum=0.80, step=0.05, value=0.50,
                            )
                            max_frames_s = gr.Slider(
                                label="Max frames  (0 = unlimited)",
                                minimum=0, maximum=3600, step=50, value=0,
                            )
                        with gr.Row():
                            stride_s = gr.Slider(
                                label="Inference stride  (1 = every frame)",
                                minimum=1, maximum=30, step=1, value=5,
                            )
                            leus_fps_s = gr.Slider(
                                label="FPS for .leus input",
                                minimum=1, maximum=30, step=1, value=5,
                            )

                    with gr.Group():
                        gr.Markdown("**Display toggles**")
                        with gr.Row():
                            show_liver_cb   = gr.Checkbox(label="Liver bounding box", value=True)
                            show_vessels_cb = gr.Checkbox(label="Vessels fill",        value=True)
                            show_labels_cb  = gr.Checkbox(label="Structure labels",    value=True)

                    with gr.Row():
                        process_btn  = gr.Button("Process Video", variant="primary")
                        rerender_btn = gr.Button("Re-render")

                    log_out = gr.Textbox(label="Log", lines=8, interactive=False)

                with gr.Column(scale=1):
                    video_out = gr.Video(label="Segmented output", autoplay=True)
                    with gr.Row():
                        mp4_dl  = gr.File(label="Download annotated MP4",  visible=True)
                        leus_dl = gr.File(label="Download .leus",          visible=True)

            process_btn.click(
                process_video,
                inputs=[
                    mp4_in, leus_in, ckpt_t, msam_t,
                    thresh_s, max_frames_s, leus_fps_s, stride_s,
                    show_liver_cb, show_vessels_cb, show_labels_cb,
                ],
                outputs=[video_out, leus_dl, cached_state, log_out],
            ).then(
                fn=lambda v: v,
                inputs=[video_out],
                outputs=[mp4_dl],
            )

            rerender_btn.click(
                fn=lambda state, sl, sv, slbl: rerender_video(
                    state, sl, sv, show_ligaments=False, show_labels=slbl, show_segments=False
                ),
                inputs=[cached_state, show_liver_cb, show_vessels_cb, show_labels_cb],
                outputs=[video_out, log_out],
            ).then(
                fn=lambda v: v,
                inputs=[video_out],
                outputs=[mp4_dl],
            )

            for _cb in [show_liver_cb, show_vessels_cb, show_labels_cb]:
                _cb.change(
                    fn=lambda state, sl, sv, slbl: rerender_video(
                        state, sl, sv, show_ligaments=False, show_labels=slbl, show_segments=False
                    ),
                    inputs=[cached_state, show_liver_cb, show_vessels_cb, show_labels_cb],
                    outputs=[video_out, log_out],
                ).then(
                    fn=lambda v: v,
                    inputs=[video_out],
                    outputs=[mp4_dl],
                )

        # ── Tab 3: Interpolate ─────────────────────────────────────────────────
        with gr.Tab("Interpolate"):
            gr.Markdown(
                "Upsample the last rendered video to a higher frame rate using **RIFE** "
                "(Real-Time Intermediate Flow Estimation).\n\n"
                "Interpolation runs on **raw EUS frames** — before overlays are drawn — "
                "so outlines and segment labels stay pixel-sharp on every synthetic frame.\n\n"
                "**Requires:** `rife-ncnn-vulkan` binary.  "
                "Download from [github.com/nihui/rife-ncnn-vulkan/releases]"
                "(https://github.com/nihui/rife-ncnn-vulkan/releases), "
                "place in PATH or enter the full path below."
            )

            with gr.Row():
                with gr.Column(scale=1):
                    state_info3 = gr.Textbox(
                        label="Cached video",
                        interactive=False,
                        placeholder="No video rendered yet — run Tab 1 or Tab 2 first.",
                    )
                    target_fps_s = gr.Slider(
                        label="Target FPS",
                        minimum=15, maximum=60, step=1, value=30,
                    )
                    rife_bin_t = gr.Textbox(
                        label="rife-ncnn-vulkan binary",
                        value=r"C:\Programs Misc\rife-ncnn-vulkan-20221029-windows\rife-ncnn-vulkan.exe",
                        placeholder="rife-ncnn-vulkan  (or full path to binary / .exe)",
                    )
                    interp_btn = gr.Button("Interpolate", variant="primary")
                    log_out3   = gr.Textbox(label="Log", lines=6, interactive=False)

                with gr.Column(scale=1):
                    video_out3 = gr.Video(label="Interpolated output", autoplay=True)
                    mp4_dl3    = gr.File(label="Download MP4", visible=True)

            # Keep state_info3 in sync whenever a new video is rendered
            cached_state.change(
                fn=_state_summary,
                inputs=[cached_state],
                outputs=[state_info3],
            )

            interp_btn.click(
                interpolate_from_state,
                inputs=[cached_state, target_fps_s, rife_bin_t],
                outputs=[video_out3, log_out3],
            ).then(
                fn=lambda v: v,
                inputs=[video_out3],
                outputs=[mp4_dl3],
            )

            gr.Markdown("---")
            gr.Markdown(
                "### Apply Masks to High-FPS Video\n\n"
                "Upload a `.leus` annotation file and a high-FPS video of the same procedure. "
                "Masks are **smoothly interpolated** between annotated frames — "
                "no snap transitions, no frame synthesis required.\n\n"
                "If no `.leus` file is uploaded, annotations from the last Tab 1 run are used."
            )
            with gr.Row():
                with gr.Column(scale=1):
                    hfps_leus_in  = gr.File(
                        label=".leus annotation file",
                        file_types=[".leus"],
                    )
                    hfps_fps_s    = gr.Slider(
                        label="Annotation FPS (rate the .leus was captured at)",
                        minimum=1, maximum=60, step=0.5, value=11,
                    )
                    hfps_video_in = gr.Video(label="High-FPS video (MP4)")
                    apply_btn     = gr.Button("Apply Masks", variant="primary")
                    log_out_hfps  = gr.Textbox(label="Log", lines=5, interactive=False)
                with gr.Column(scale=1):
                    video_out_hfps = gr.Video(label="Output", autoplay=True)
                    mp4_dl_hfps    = gr.File(label="Download MP4", visible=True)

            apply_btn.click(
                apply_masks_to_hfps_video,
                inputs=[cached_state, hfps_video_in, hfps_leus_in, hfps_fps_s],
                outputs=[video_out_hfps, log_out_hfps],
            ).then(
                fn=lambda v: v,
                inputs=[video_out_hfps],
                outputs=[mp4_dl_hfps],
            )

        # ── Tab 4: Layout Video ──────────────────────────────────────────────
        with gr.Tab("Layout Video"):
            gr.Markdown(
                "Generate a **1920×1080 layout video** combining all panels:\n\n"
                "1. Segmented EUS video (center)\n"
                "2. Station diagram — TG first 80%, TD last 20% (left top)\n"
                "3. Active labels list (left bottom)\n"
                "4. Viewport signal video (right top)\n"
                "5. Liver cross-section highlight (right bottom)\n\n"
                "Requires cached data from the **.leus → Outline Video** tab."
            )
            with gr.Row():
                with gr.Column(scale=1):
                    layout_btn = gr.Button("Generate Layout Video", variant="primary")
                    log_out4 = gr.Textbox(label="Log", lines=4, interactive=False)
                with gr.Column(scale=2):
                    video_out4 = gr.Video(label="Layout output", autoplay=True)
                    mp4_dl4 = gr.File(label="Download MP4", visible=True)

            layout_btn.click(
                generate_layout_video,
                inputs=[cached_state],
                outputs=[video_out4, log_out4],
            ).then(
                fn=lambda v: v,
                inputs=[video_out4],
                outputs=[mp4_dl4],
            )

    return demo


# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7861)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    demo = build_ui()
    demo.launch(
        server_port=args.port,
        inbrowser=not args.no_browser,
        css=_CSS,
        show_error=True,
        quiet=False,
    )
