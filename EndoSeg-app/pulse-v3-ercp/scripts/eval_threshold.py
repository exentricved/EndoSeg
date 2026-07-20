#!/usr/bin/env python3
"""
eval_threshold.py — Sigmoid threshold & erosion sweep for liver autosegmentation.

Runs inference once per case using the fine-tuned MobileSAM checkpoint, caches
raw logit maps, then sweeps sigmoid threshold × erosion radius combinations and
reports Dice / IoU / Precision / Recall for each.

Usage (from project root):
    python scripts/eval_threshold.py
    python scripts/eval_threshold.py --dataset output --checkpoint checkpoints/best_checkpoint.pth \\
        --medsam checkpoints/mobile_sam.pt --out eval_results.csv

Precision directly measures bleeding: high precision = less mask outside liver.
"""

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

# Allow importing from the same scripts/ directory
sys.path.insert(0, str(Path(__file__).parent))
from autoliver_pipeline_ui import _get_medsam_lite  # noqa: E402

try:
    from PIL import Image
except ImportError:
    print("ERROR: Pillow not installed. Run: pip install Pillow")
    sys.exit(1)

try:
    from scipy.ndimage import binary_erosion
except ImportError:
    print("ERROR: scipy not installed. Run: pip install scipy")
    sys.exit(1)

MODEL_SIZE = 1024


# ── Preprocessing (mirrors EUSDataset.__getitem__ and mlSegmentation.ts) ──────

def _sobel(gray: np.ndarray) -> np.ndarray:
    gy = np.gradient(gray, axis=0)
    gx = np.gradient(gray, axis=1)
    mag = np.sqrt(gx**2 + gy**2)
    mx = mag.max()
    return mag / mx if mx > 0 else mag


def preprocess_image(img_path: Path) -> torch.Tensor:
    """Load image → resize to 1024 → 6-channel tensor (1, 6, 1024, 1024)."""
    img = Image.open(img_path).convert("RGB")
    img = img.resize((MODEL_SIZE, MODEL_SIZE), Image.BILINEAR)
    rgb = np.array(img).astype(np.float32) / 255.0  # H W 3
    gray = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    sobel = _sobel(gray)
    xmap = np.tile(np.linspace(0, 1, MODEL_SIZE, dtype=np.float32), (MODEL_SIZE, 1))
    ymap = np.tile(np.linspace(0, 1, MODEL_SIZE, dtype=np.float32).reshape(-1, 1), (1, MODEL_SIZE))
    channels = np.stack([rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2], sobel, xmap, ymap], axis=0)
    return torch.from_numpy(channels).unsqueeze(0)  # (1, 6, H, W)


def load_gt_mask(mask_path: Path) -> np.ndarray:
    """Load ground-truth mask PNG → binary liver mask (1024×1024, bool)."""
    mask = Image.open(mask_path).resize((MODEL_SIZE, MODEL_SIZE), Image.NEAREST)
    return (np.array(mask).astype(np.uint8) == 1)


# ── Inference — encoder + center-point prompt ─────────────────────────────────

def run_inference(model, img_tensor: torch.Tensor, device: torch.device) -> np.ndarray:
    """
    Run encoder → center-point prompt → decoder → upsampled logit map.
    Returns raw float32 logit array (1024, 1024) — NOT sigmoid-thresholded.
    Uses a single positive center-point prompt to match the annotator first-pass.
    """
    img_tensor = img_tensor.to(device)

    with torch.no_grad():
        img_emb = model.image_encoder(img_tensor)  # (1, C, H', W')

        # Center-point prompt (normalised coordinates)
        pt_coords = torch.tensor([[[0.5, 0.5]]], dtype=torch.float32, device=device)  # (1, 1, 2)
        pt_labels = torch.tensor([[1]], dtype=torch.float32, device=device)            # (1, 1)

        sparse_emb, dense_emb = model.prompt_encoder(
            points=(pt_coords, pt_labels), boxes=None, masks=None
        )
        pred_masks, _ = model.mask_decoder(
            image_embeddings=img_emb,
            image_pe=model.prompt_encoder.get_dense_pe(),
            sparse_prompt_embeddings=sparse_emb,
            dense_prompt_embeddings=dense_emb,
            multimask_output=False,
        )
        pred_up = F.interpolate(pred_masks, size=(MODEL_SIZE, MODEL_SIZE),
                                mode="bilinear", align_corners=False)

    return pred_up[0, 0].cpu().numpy()  # (1024, 1024) raw logits


# ── Metrics ───────────────────────────────────────────────────────────────────

def compute_metrics(pred_bin: np.ndarray, gt: np.ndarray) -> dict:
    # True negative: both pred and GT are empty → perfect prediction
    if not pred_bin.any() and not gt.any():
        return {"dice": 1.0, "iou": 1.0, "precision": 1.0, "recall": 1.0,
                "true_negative": True}
    tp = (pred_bin & gt).sum()
    fp = (pred_bin & ~gt).sum()
    fn = (~pred_bin & gt).sum()
    precision = tp / (tp + fp + 1e-6)
    recall    = tp / (tp + fn + 1e-6)
    dice      = 2 * tp / (2 * tp + fp + fn + 1e-6)
    iou       = tp / (tp + fp + fn + 1e-6)
    return {"dice": float(dice), "iou": float(iou),
            "precision": float(precision), "recall": float(recall),
            "true_negative": False}


def apply_erosion(mask: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return mask
    struct = np.ones((2 * radius + 1, 2 * radius + 1), dtype=bool)
    return binary_erosion(mask, structure=struct)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Threshold & erosion sweep for liver autoseg")
    parser.add_argument("--dataset",    default="../output",                              help="Prepared dataset directory")
    parser.add_argument("--checkpoint", default="../checkpoints/best_checkpoint.pth",    help="Fine-tuned model checkpoint")
    parser.add_argument("--medsam",     default="../checkpoints/mobile_sam.pt",           help="MobileSAM pretrained weights")
    parser.add_argument("--out",        default="eval_results.csv",                       help="Output CSV path")
    args = parser.parse_args()

    dataset_dir  = Path(args.dataset)
    ckpt_path    = Path(args.checkpoint)
    medsam_path  = Path(args.medsam)
    out_csv      = Path(args.out)

    # Validate paths
    for p, name in [(dataset_dir, "dataset"), (ckpt_path, "checkpoint"), (medsam_path, "medsam")]:
        if not p.exists():
            print(f"ERROR: {name} not found: {p}")
            sys.exit(1)

    with open(dataset_dir / "dataset.json") as f:
        ds_info = json.load(f)
    records = [{"case_id": Path(r["image"]).stem} for r in ds_info.get("training", [])]
    print(f"Cases: {len(records)}")

    # Load model
    print("Loading model...")
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")
    model = _get_medsam_lite(str(medsam_path))
    state = torch.load(str(ckpt_path), map_location="cpu", weights_only=False)
    if not isinstance(state, dict):
        state = state.state_dict()
    model.load_state_dict(state, strict=False)
    model.to(device).eval()
    print("Model ready.\n")

    # ── Phase 1: run inference once per case, cache logits ───────────────────
    img_dir  = dataset_dir / "images"
    mask_dir = dataset_dir / "masks"

    logit_cache = []  # list of (logits np.ndarray, gt np.ndarray)
    for i, rec in enumerate(records, 1):
        cid = rec["case_id"]
        img_t = preprocess_image(img_dir / f"{cid}.png")
        gt    = load_gt_mask(mask_dir / f"{cid}.png")
        logits = run_inference(model, img_t, device)
        logit_cache.append((logits, gt))
        print(f"  [{i:02d}/{len(records)}] {cid} — liver px: {gt.sum()}", end="\r")

    print(f"\nInference complete ({len(logit_cache)} cases).\n")

    # ── Phase 2: sweep thresholds × erosion radii ────────────────────────────
    thresholds    = [round(t, 2) for t in np.arange(0.30, 0.80, 0.05)]
    erosion_radii = [0, 1, 2, 3]

    all_rows = []  # for CSV

    summary = []  # (thresh, erode, mean_dice, mean_iou, mean_prec, mean_rec)

    for thresh in thresholds:
        for erode_r in erosion_radii:
            per_case = []
            for logits, gt in logit_cache:
                pred_bin = (1 / (1 + np.exp(-logits))) > thresh
                pred_bin = apply_erosion(pred_bin, erode_r)
                m = compute_metrics(pred_bin, gt)
                per_case.append(m)
                all_rows.append({
                    "thresh": thresh, "erode": erode_r,
                    **m,
                })

            mean_dice = np.mean([m["dice"]      for m in per_case])
            mean_iou  = np.mean([m["iou"]       for m in per_case])
            mean_prec = np.mean([m["precision"] for m in per_case])
            mean_rec  = np.mean([m["recall"]    for m in per_case])
            summary.append((thresh, erode_r, mean_dice, mean_iou, mean_prec, mean_rec))

    # ── Print summary table sorted by precision descending ───────────────────
    summary.sort(key=lambda r: r[4], reverse=True)  # sort by precision

    header = f"{'thresh':>7}  {'erode':>5}  {'dice':>6}  {'iou':>6}  {'precision':>9}  {'recall':>7}"
    sep    = "-" * len(header)
    print(header)
    print(sep)

    current_default = None
    for thresh, erode_r, dice, iou, prec, rec in summary:
        tag = "  <-- current default" if (thresh == 0.50 and erode_r == 0) else ""
        if thresh == 0.50 and erode_r == 0:
            current_default = (dice, iou, prec, rec)
        print(f"{thresh:>7.2f}  {erode_r:>5d}  {dice:>6.3f}  {iou:>6.3f}  {prec:>9.3f}  {rec:>7.3f}{tag}")

    print(sep)
    if current_default:
        print(f"\nCurrent annotator default (thresh=0.50, erode=0):")
        print(f"  Dice={current_default[0]:.3f}  IoU={current_default[1]:.3f}  "
              f"Precision={current_default[2]:.3f}  Recall={current_default[3]:.3f}")

    # ── Write CSV ─────────────────────────────────────────────────────────────
    with open(out_csv, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["thresh", "erode", "dice", "iou", "precision", "recall"])
        writer.writeheader()
        writer.writerows(all_rows)
    print(f"\nPer-case results saved to: {out_csv}")


if __name__ == "__main__":
    main()
