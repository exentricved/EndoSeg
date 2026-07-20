#!/usr/bin/env python3
"""
Smoke tests for the liver-segment additions to video_seg_ui.py.
Run with:  python scripts/test_video_seg_segments.py
"""

import base64, io, json, sys, traceback, uuid
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

# ── import the module under test ───────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent))
import video_seg_ui as vsu

PASS = "PASS"
FAIL = "FAIL"


def _result(name, ok, detail=""):
    status = PASS if ok else FAIL
    print(f"  [{status}] {name}" + (f" — {detail}" if detail else ""))
    return ok


# ── helpers to build synthetic .leus data ─────────────────────────────────────

def _blank_png_b64(w=64, h=64) -> str:
    pil = Image.fromarray(np.zeros((h, w, 3), dtype=np.uint8), "RGB")
    buf = io.BytesIO(); pil.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _mask_png_b64(w=64, h=64, fill_rect=None) -> str:
    """RGBA PNG where fill_rect=(x0,y0,x1,y1) is fully opaque, rest transparent."""
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    if fill_rect:
        x0, y0, x1, y1 = fill_rect
        arr[y0:y1, x0:x1, 3] = 255
    pil = Image.fromarray(arr, "RGBA")
    buf = io.BytesIO(); pil.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _make_leus(labels: list[dict]) -> str:
    """Write a minimal .leus JSON to a temp file and return its path."""
    import tempfile
    proj = {
        "version": 2, "organ": "liver", "modality": "linear-eus",
        "images": [{
            "id": str(uuid.uuid4()), "name": "frame_0001",
            "w": 64, "h": 64,
            "baseURL": _blank_png_b64(),
            "station": "",
            "labels": labels,
        }],
    }
    tmp = tempfile.mktemp(suffix=".leus")
    with open(tmp, "w") as f:
        json.dump(proj, f)
    return tmp


# ══════════════════════════════════════════════════════════════════════════════
# Test 1 — _to_roman
# ══════════════════════════════════════════════════════════════════════════════

def test_roman_numerals():
    print("\n[Test] _to_roman")
    cases = {1:"I", 2:"II", 3:"III", 4:"IV", 5:"V",
             6:"VI", 7:"VII", 8:"VIII", 9:"IX", 10:"X", 14:"XIV"}
    ok = True
    for n, expected in cases.items():
        got = vsu._to_roman(n)
        passed = got == expected
        ok = ok and passed
        _result(f"_to_roman({n})", passed, f"got '{got}', want '{expected}'" if not passed else "")
    return ok


# ══════════════════════════════════════════════════════════════════════════════
# Test 2 — SEGMENT_IDS / SEGMENT_BGRS / SEGMENT_OUTLINE_THICKNESS constants
# ══════════════════════════════════════════════════════════════════════════════

def test_constants():
    print("\n[Test] segment constants")
    ok = True
    ok = _result("SEGMENT_IDS == {9..16}", vsu.SEGMENT_IDS == set(range(9, 17))) and ok
    ok = _result("SEGMENT_BGRS has 8 entries", len(vsu.SEGMENT_BGRS) == 8) and ok
    ok = _result("SEGMENT_OUTLINE_THICKNESS > 2", vsu.SEGMENT_OUTLINE_THICKNESS > 2) and ok
    # 20% thicker: ceil(2*1.2)=3
    ok = _result("SEGMENT_OUTLINE_THICKNESS == 5", vsu.SEGMENT_OUTLINE_THICKNESS == 5) and ok
    # All BGR tuples have 3 components in [0,255]
    bgr_ok = all(
        len(v) == 3 and all(0 <= c <= 255 for c in v)
        for v in vsu.SEGMENT_BGRS.values()
    )
    ok = _result("All SEGMENT_BGRS are valid BGR tuples", bgr_ok) and ok
    return ok


# ══════════════════════════════════════════════════════════════════════════════
# Test 3 — _draw_label_centered draws inside image without crashing
# ══════════════════════════════════════════════════════════════════════════════

def test_draw_label_centered():
    print("\n[Test] _draw_label_centered")
    ok = True
    img = np.zeros((240, 320, 3), dtype=np.uint8)
    try:
        vsu._draw_label_centered(img, "III", 160, 120, (0, 255, 0))
        ok = _result("no exception at centre", True)
    except Exception as e:
        ok = _result("no exception at centre", False, str(e))

    # Edge: top-left corner
    try:
        vsu._draw_label_centered(img, "VIII", 0, 0, (255, 0, 0))
        ok = _result("no exception at (0,0)", True) and ok
    except Exception as e:
        ok = _result("no exception at (0,0)", False, str(e)) and ok

    # Edge: bottom-right corner
    try:
        vsu._draw_label_centered(img, "IV", 319, 239, (0, 0, 255))
        ok = _result("no exception at bottom-right", True) and ok
    except Exception as e:
        ok = _result("no exception at bottom-right", False, str(e)) and ok

    return ok


# ══════════════════════════════════════════════════════════════════════════════
# Test 4 — _leus_to_frames extracts segment masks
# ══════════════════════════════════════════════════════════════════════════════

def test_leus_segment_extraction():
    print("\n[Test] _leus_to_frames — segment mask extraction")
    ok = True

    # Frame with Segment 1 (id=9) masked in top-left quadrant
    leus_path = _make_leus([
        {"id": 9,  "name": "Segment 1", "color": "#9B59B6",
         "maskPNG": _mask_png_b64(fill_rect=(0, 0, 32, 32))},
        {"id": 13, "name": "Segment 5", "color": "#E74C3C",
         "maskPNG": _mask_png_b64(fill_rect=(32, 32, 64, 64))},
        {"id": 1,  "name": "Liver",     "color": "#8B4513",
         "maskPNG": _mask_png_b64(fill_rect=(0, 0, 64, 64))},
    ])

    try:
        frames, liver_m, portal_m, hepatic_m, ligament_m, seg_list, w, h = \
            vsu._leus_to_frames(leus_path)

        ok = _result("returns 1 frame", len(frames) == 1) and ok
        ok = _result("liver mask present", liver_m[0] is not None) and ok
        ok = _result("no portal mask", portal_m[0] is None) and ok

        segs = seg_list[0]
        ok = _result("segment_masks_list has entry", len(segs) > 0) and ok
        ok = _result("Segment 1 (id=9) extracted",  9 in segs) and ok
        ok = _result("Segment 5 (id=13) extracted", 13 in segs) and ok
        ok = _result("no spurious segment ids",
                     all(sid in vsu.SEGMENT_IDS for sid in segs)) and ok

        # Masks should be MODEL_SIZE×MODEL_SIZE
        for sid, m in segs.items():
            ok = _result(f"seg {sid} mask shape == ({vsu.MODEL_SIZE},{vsu.MODEL_SIZE})",
                         m.shape == (vsu.MODEL_SIZE, vsu.MODEL_SIZE)) and ok
            ok = _result(f"seg {sid} mask has nonzero pixels", m.any()) and ok

    except Exception as e:
        traceback.print_exc()
        ok = _result("_leus_to_frames ran without exception", False, str(e)) and ok

    return ok


# ══════════════════════════════════════════════════════════════════════════════
# Test 5 — _render_frame_outlines draws segment contours without error
# ══════════════════════════════════════════════════════════════════════════════

def test_render_frame_outlines_segments():
    print("\n[Test] _render_frame_outlines — segment outlines rendered")
    ok = True

    # Build a synthetic frame and frame_data with two segments
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    scale = vsu.MODEL_SIZE

    def _rect_cnt(x0, y0, x1, y1):
        """Return a single rectangular contour in MODEL_SIZE space."""
        return np.array([[[x0,y0]],[[x1,y0]],[[x1,y1]],[[x0,y1]]], dtype=np.int32)

    fd = {
        "liver_cnts":    [_rect_cnt(50, 50, 900, 900)],
        "portal_cnts":   [],
        "hepatic_cnts":  [],
        "ligament_cnts": [],
        "segment_cnts":  {
             9: [_rect_cnt(100, 100, 400, 400)],   # Seg 1
            13: [_rect_cnt(500, 100, 900, 500)],   # Seg 5
        },
    }

    try:
        out = vsu._render_frame_outlines(
            frame, fd,
            show_liver=True, show_vessels=False,
            show_ligaments=False, show_labels=True,
        )
        ok = _result("no exception", True) and ok
        ok = _result("output shape matches input", out.shape == frame.shape) and ok

        # Some pixels should have been written (not all black)
        ok = _result("frame has non-black pixels after rendering", out.any()) and ok

    except Exception as e:
        traceback.print_exc()
        ok = _result("no exception", False, str(e)) and ok

    return ok


# ══════════════════════════════════════════════════════════════════════════════
# Test 6 — frame_data with no segment_cnts key (backwards compat)
# ══════════════════════════════════════════════════════════════════════════════

def test_render_backwards_compat():
    print("\n[Test] _render_frame_outlines — missing segment_cnts key (backwards compat)")
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    fd = {
        "liver_cnts": [], "portal_cnts": [],
        "hepatic_cnts": [], "ligament_cnts": [],
        # no "segment_cnts" key
    }
    try:
        vsu._render_frame_outlines(
            frame, fd,
            show_liver=False, show_vessels=False,
            show_ligaments=False, show_labels=False,
        )
        return _result("no KeyError when segment_cnts absent", True)
    except Exception as e:
        return _result("no KeyError when segment_cnts absent", False, str(e))


# ══════════════════════════════════════════════════════════════════════════════
# Runner
# ══════════════════════════════════════════════════════════════════════════════

def main():
    tests = [
        test_roman_numerals,
        test_constants,
        test_draw_label_centered,
        test_leus_segment_extraction,
        test_render_frame_outlines_segments,
        test_render_backwards_compat,
    ]
    results = [t() for t in tests]
    n_pass = sum(results)
    n_fail = len(results) - n_pass
    print(f"\n{'='*50}")
    print(f"Results: {n_pass}/{len(results)} passed" +
          (f"  ({n_fail} FAILED)" if n_fail else "  — all good!"))
    sys.exit(0 if n_fail == 0 else 1)


if __name__ == "__main__":
    main()
