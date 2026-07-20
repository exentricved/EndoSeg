#!/usr/bin/env python3
"""Liver EUS Autosegmentation Pipeline
Unified Gradio UI for data prep, training, validation, and ONNX export.

Requirements:
  pip install gradio pillow numpy torch torchvision monai huggingface_hub
  pip install git+https://github.com/ChaoningZhang/MobileSAM.git
Usage: python scripts/pipeline_ui.py
"""

import os, sys, json, base64, io, csv, shutil, threading
from pathlib import Path

try:
    import gradio as gr
    HAS_GRADIO = True
except ImportError:
    HAS_GRADIO = False

try:
    from PIL import Image
    import numpy as np
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch.utils.data import Dataset, DataLoader
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

try:
    from monai.losses import DiceLoss
    HAS_MONAI = True
except ImportError:
    HAS_MONAI = False

try:
    from huggingface_hub import hf_hub_download
    HAS_HF = True
except ImportError:
    HAS_HF = False

try:
    import matplotlib.cm as _mpl_cm
    HAS_MPL = True
except ImportError:
    HAS_MPL = False


# ── Canonical label map (matches App.tsx TIER2A_LABELS) ────────────────────────
LABEL_NAMES = {
    0: "background",
    1: "Liver",
    2: "Ligaments",
    3: "Portal Vein",
    4: "Hepatic Vein",
    5: "Bile Duct",
    6: "Gall Bladder",
    7: "Hepatic Artery",
    8: "IVC",
}
NAME_TO_IDX = {v: k for k, v in LABEL_NAMES.items()}

# ── Phase 1: Data Preparation ──────────────────────────────────────────────────

def _decode_base64_image(data_url: str) -> "Image.Image":
    """Decode a base64 data URL (or raw base64) to a PIL Image."""
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    raw = base64.b64decode(data_url)
    return Image.open(io.BytesIO(raw))


def prepare_dataset(leus_paths: list[str], output_dir: str) -> str:
    """
    Phase 1: Parse .leus files → image/mask PNG pairs + dataset.json + manifest.csv.
    Returns a multi-line log string.
    """
    if not HAS_PIL:
        return "ERROR: Pillow not installed. Run: pip install Pillow numpy"

    logs = []
    out = Path(output_dir)
    img_dir = out / "images"
    mask_dir = out / "masks"
    img_dir.mkdir(parents=True, exist_ok=True)
    mask_dir.mkdir(parents=True, exist_ok=True)

    records = []
    case_counter = 0
    next_unknown_idx = 9  # labels beyond the canonical 8 get indices ≥ 9

    for leus_path in leus_paths:
        try:
            with open(leus_path, "r", encoding="utf-8") as f:
                project = json.load(f)
        except Exception as e:
            logs.append(f"SKIP {leus_path}: cannot parse JSON — {e}")
            continue

        images = project.get("images", [])
        for img_entry in images:
            base_url = img_entry.get("baseURL", "")
            if not base_url:
                logs.append(f"SKIP image in {leus_path}: missing baseURL")
                continue

            try:
                pil_img = _decode_base64_image(base_url).convert("RGB")
            except Exception as e:
                logs.append(f"SKIP image in {leus_path}: cannot decode baseURL — {e}")
                continue

            w, h = pil_img.size
            label_map = np.zeros((h, w), dtype=np.uint8)
            labels_present = []

            for lbl in img_entry.get("labels", []):
                mask_png = lbl.get("maskPNG")
                if not mask_png:
                    continue
                name = lbl.get("name", "")
                if name in NAME_TO_IDX:
                    idx = NAME_TO_IDX[name]
                else:
                    logs.append(f"  WARNING: unknown label '{name}' → assigned index {next_unknown_idx}")
                    NAME_TO_IDX[name] = next_unknown_idx
                    LABEL_NAMES[next_unknown_idx] = name
                    idx = next_unknown_idx
                    next_unknown_idx += 1

                try:
                    mask_img = _decode_base64_image(mask_png).convert("RGBA")
                except Exception as e:
                    logs.append(f"  SKIP mask '{name}' in {leus_path}: {e}")
                    continue

                alpha = np.array(mask_img)[:, :, 3]
                label_map[alpha > 0] = idx
                labels_present.append(name)

            case_counter += 1
            case_id = f"case{case_counter:04d}"
            station = img_entry.get("station", "")

            pil_img.save(img_dir / f"{case_id}.png")

            if not labels_present:
                # Hard negative: no annotations → save all-zero mask
                Image.fromarray(np.zeros((h, w), dtype=np.uint8)).save(mask_dir / f"{case_id}.png")
                records.append({
                    "case_id": case_id,
                    "source_leus": str(leus_path),
                    "labels_present": "",
                    "image_size": f"{w}x{h}",
                    "station": station,
                })
                logs.append(f"  OK (negative) {case_id}: {w}x{h}, station={station or 'unset'}")
            else:
                Image.fromarray(label_map).save(mask_dir / f"{case_id}.png")
                records.append({
                    "case_id": case_id,
                    "source_leus": str(leus_path),
                    "labels_present": "|".join(labels_present),
                    "image_size": f"{w}x{h}",
                    "station": station,
                })
                logs.append(f"  OK {case_id}: {w}x{h}, labels=[{', '.join(labels_present)}], station={station or 'unset'}")

    # Write dataset.json
    dataset = {
        "name": "liver-eus-segmentation",
        "modality": "linear-eus",
        "labels": {str(k): v for k, v in sorted(LABEL_NAMES.items())},
        "numTraining": len(records),
        "training": [
            {
                "image": f"images/{r['case_id']}.png",
                "label": f"masks/{r['case_id']}.png",
                "station": r["station"],
            }
            for r in records
        ],
    }
    with open(out / "dataset.json", "w") as f:
        json.dump(dataset, f, indent=2)

    # Write manifest.csv
    if records:
        with open(out / "manifest.csv", "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["case_id", "source_leus", "labels_present", "image_size", "station"])
            writer.writeheader()
            writer.writerows(records)

    summary = f"\n--- Done: {len(records)} cases exported to {output_dir} ---"
    logs.append(summary)
    return "\n".join(logs)


# ── Phase 2: Model definition ──────────────────────────────────────────────────

def _get_medsam_lite(checkpoint_path: str):
    """Load MobileSAM (TinyViT-5M); modify patch embedding to accept 6 channels."""
    if not HAS_TORCH:
        raise RuntimeError("PyTorch not installed.")
    try:
        from mobile_sam import sam_model_registry  # type: ignore
    except ImportError:
        raise RuntimeError(
            "MobileSAM not installed.\n"
            "Run: pip install git+https://github.com/ChaoningZhang/MobileSAM.git"
        )

    # Build architecture without loading checkpoint (avoids internal .proj access)
    model = sam_model_registry["vit_t"](checkpoint=None)

    # Load pretrained weights manually so we control the process
    try:
        state = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    except Exception:
        state = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    if not isinstance(state, dict):
        state = state.state_dict()
    model.load_state_dict(state, strict=False)

    # Now expand patch_embed from 3 → 6 input channels.
    # TinyViT: patch_embed.seq[0] is Conv2d_BN; the Conv2d inside is attribute 'c'.
    first_block = model.image_encoder.patch_embed.seq[0]
    orig_conv = None
    for m in first_block.modules():
        if isinstance(m, nn.Conv2d):
            orig_conv = m
            break
    if orig_conv is None:
        raise RuntimeError("Could not find Conv2d in patch_embed.seq[0]")

    new_conv = nn.Conv2d(
        6, orig_conv.out_channels,
        kernel_size=orig_conv.kernel_size,
        stride=orig_conv.stride,
        padding=orig_conv.padding,
        bias=orig_conv.bias is not None,
    )
    with torch.no_grad():
        new_conv.weight[:, :3] = orig_conv.weight  # keep pretrained RGB weights
        nn.init.zeros_(new_conv.weight[:, 3:])     # new channels start near zero
        if orig_conv.bias is not None:
            new_conv.bias.copy_(orig_conv.bias)
    first_block.c = new_conv
    return model


class EUSDataset(Dataset):
    def __init__(self, records, img_dir, mask_dir, augment=False):
        self.records = records
        self.img_dir = Path(img_dir)
        self.mask_dir = Path(mask_dir)
        self.augment = augment

    def __len__(self):
        return len(self.records)

    def _sobel(self, gray):
        """Compute Sobel edge map (numpy, H×W float32, normalized)."""
        gy = np.gradient(gray, axis=0)
        gx = np.gradient(gray, axis=1)
        mag = np.sqrt(gx**2 + gy**2)
        mx = mag.max()
        return mag / mx if mx > 0 else mag

    def __getitem__(self, idx):
        from PIL import Image  # local import for Dataset use in workers
        import torchvision.transforms.functional as TF

        rec = self.records[idx]
        img = Image.open(self.img_dir / f"{rec['case_id']}.png").convert("RGB")
        mask = Image.open(self.mask_dir / f"{rec['case_id']}.png")

        # Resize to 1024×1024
        img = img.resize((1024, 1024), Image.BILINEAR)
        mask = mask.resize((1024, 1024), Image.NEAREST)

        if self.augment:
            import random
            if random.random() > 0.5:
                img = TF.hflip(img)
                mask = TF.hflip(mask)
            # Brightness / contrast jitter
            img = TF.adjust_brightness(img, 1 + (random.random() - 0.5) * 0.4)
            img = TF.adjust_contrast(img, 1 + (random.random() - 0.5) * 0.4)
            # Gaussian noise
            arr = np.array(img).astype(np.float32)
            arr += np.random.randn(*arr.shape).astype(np.float32) * 8
            arr = np.clip(arr, 0, 255).astype(np.uint8)
            img = Image.fromarray(arr)

        rgb = np.array(img).astype(np.float32) / 255.0  # H, W, 3
        gray = 0.299*rgb[:,:,0] + 0.587*rgb[:,:,1] + 0.114*rgb[:,:,2]
        sobel = self._sobel(gray)
        xmap = np.tile(np.linspace(0, 1, 1024, dtype=np.float32), (1024, 1))
        ymap = np.tile(np.linspace(0, 1, 1024, dtype=np.float32).reshape(-1, 1), (1, 1024))

        # (6, H, W)
        channels = np.stack([rgb[:,:,0], rgb[:,:,1], rgb[:,:,2], sobel, xmap, ymap], axis=0)
        img_tensor = torch.from_numpy(channels)

        mask_np = np.array(mask).astype(np.uint8)
        # Binary mask: liver = class 1
        binary = (mask_np == 1).astype(np.float32)

        # Sample point prompts: positive + negative for annotated images,
        # two background (negative) prompts for hard-negative (all-zero mask) images.
        ys,  xs  = np.where(binary > 0)
        ys0, xs0 = np.where(binary == 0)

        if len(ys) > 0:
            # Positive case: one inside-liver prompt (label=1) + one outside (label=0)
            i = np.random.randint(len(ys))
            pos_pt = [xs[i] / 1024.0, ys[i] / 1024.0]
            if len(ys0) > 0:
                j = np.random.randint(len(ys0))
                neg_pt = [xs0[j] / 1024.0, ys0[j] / 1024.0]
            else:
                neg_pt = [0.1, 0.1]
            point_coords = torch.tensor([pos_pt, neg_pt], dtype=torch.float32)  # (2, 2)
            point_labels = torch.tensor([1, 0], dtype=torch.float32)            # (2,)
        else:
            # Negative case: two distinct random background points, both label=0
            if len(ys0) >= 2:
                idx = np.random.choice(len(ys0), size=2, replace=False)
                pt1 = [xs0[idx[0]] / 1024.0, ys0[idx[0]] / 1024.0]
                pt2 = [xs0[idx[1]] / 1024.0, ys0[idx[1]] / 1024.0]
            else:
                pt1, pt2 = [0.3, 0.3], [0.7, 0.7]
            point_coords = torch.tensor([pt1, pt2], dtype=torch.float32)  # (2, 2)
            point_labels = torch.tensor([0, 0], dtype=torch.float32)      # (2,)

        return img_tensor, torch.from_numpy(binary).unsqueeze(0), point_coords, point_labels


# ── Phase 2: Training ──────────────────────────────────────────────────────────

def train_model(
    dataset_dir: str,
    checkpoint_path: str,
    output_dir: str,
    num_epochs: int = 20,
    batch_size: int = 2,
    use_val: bool = True,
    progress_callback=None,
) -> str:
    """
    Phase 2: Fine-tune MedSAM-Lite on prepared dataset.
    progress_callback(step, total, message) called periodically.
    Returns log string.
    """
    if not HAS_TORCH:
        return "ERROR: PyTorch not installed."
    if not HAS_MONAI:
        return "ERROR: MONAI not installed. Run: pip install monai"

    logs = []

    def log(msg):
        logs.append(msg)
        if progress_callback:
            progress_callback(msg)

    dataset_dir = Path(dataset_dir)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load dataset.json
    ds_json_path = dataset_dir / "dataset.json"
    if not ds_json_path.exists():
        return f"ERROR: dataset.json not found in {dataset_dir}"
    with open(ds_json_path) as f:
        ds_info = json.load(f)

    records_all = ds_info.get("training", [])
    if not records_all:
        return "ERROR: No training cases in dataset.json"

    # Convert to EUSDataset-compatible format
    def to_rec(r):
        stem = Path(r["image"]).stem
        return {"case_id": stem, "station": r.get("station", "")}

    records_all = [to_rec(r) for r in records_all]

    import random
    random.shuffle(records_all)

    if use_val:
        n_val = max(1, int(len(records_all) * 0.2))
        val_records   = records_all[:n_val]
        train_records = records_all[n_val:]
        log(f"Dataset: {len(train_records)} train / {len(val_records)} val")
    else:
        train_records = records_all
        val_records   = []
        log(f"Dataset: {len(train_records)} train (no validation split)")

    img_dir  = dataset_dir / "images"
    mask_dir = dataset_dir / "masks"

    train_ds = EUSDataset(train_records, img_dir, mask_dir, augment=True)
    train_dl = DataLoader(train_ds, batch_size=batch_size, shuffle=True, num_workers=0)

    if use_val:
        val_ds = EUSDataset(val_records, img_dir, mask_dir, augment=False)
        val_dl = DataLoader(val_ds, batch_size=1, shuffle=False, num_workers=0)
    else:
        val_dl = None

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    log(f"Device: {device}")

    log("Loading MedSAM-Lite checkpoint…")
    try:
        model = _get_medsam_lite(checkpoint_path)
    except Exception as e:
        return f"ERROR loading checkpoint: {e}"
    model.to(device)

    dice_loss = DiceLoss(sigmoid=True, squared_pred=True)

    def focal_loss(pred, target, gamma=2.0, alpha=0.25):
        bce = F.binary_cross_entropy_with_logits(pred, target, reduction="none")
        pt = torch.exp(-bce)
        fl = alpha * (1 - pt) ** gamma * bce
        return fl.mean()

    def combined_loss(pred, target):
        return 0.5 * dice_loss(pred, target) + 0.5 * focal_loss(pred, target)

    best_val_dice = 0.0
    best_ckpt_path = output_dir / "best_checkpoint.pth"

    import time as _time
    _epoch_durations = []

    # Create both optimizers once so Adam momentum persists within each phase.
    for p in model.image_encoder.parameters():
        p.requires_grad = False
    opt_frozen = torch.optim.Adam(
        filter(lambda p: p.requires_grad, model.parameters()), lr=1e-4
    )
    for p in model.image_encoder.parameters():
        p.requires_grad = True
    opt_full = torch.optim.Adam([
        {"params": model.image_encoder.parameters(),  "lr": 1e-5},
        {"params": model.mask_decoder.parameters(),    "lr": 1e-4},
        {"params": model.prompt_encoder.parameters(),  "lr": 1e-4},
    ])
    # Start with encoder frozen for epochs 1-5
    for p in model.image_encoder.parameters():
        p.requires_grad = False

    for epoch in range(1, num_epochs + 1):
        _ep_start = _time.time()

        if epoch == 6:          # unfreeze encoder once at the phase transition
            for p in model.image_encoder.parameters():
                p.requires_grad = True
        optimizer = opt_frozen if epoch <= 5 else opt_full

        model.train()
        train_loss = 0.0
        for imgs, masks, pt_coords, pt_labels in train_dl:
            imgs      = imgs.to(device)
            masks     = masks.to(device)
            pt_coords = pt_coords.to(device)
            pt_labels = pt_labels.to(device)

            # Encode all images in one pass (efficient), then decode one at a time.
            # SAM's decoder uses repeat_interleave internally and only handles B=1.
            with torch.no_grad():
                img_embs = model.image_encoder(imgs)  # (B, 256, 64, 64)

            batch_loss = torch.tensor(0.0, device=device)
            B = imgs.shape[0]
            for b in range(B):
                sparse_emb, dense_emb = model.prompt_encoder(
                    points=(pt_coords[b:b+1], pt_labels[b:b+1]), boxes=None, masks=None
                )
                pred_masks, _ = model.mask_decoder(
                    image_embeddings=img_embs[b:b+1],
                    image_pe=model.prompt_encoder.get_dense_pe(),
                    sparse_prompt_embeddings=sparse_emb,
                    dense_prompt_embeddings=dense_emb,
                    multimask_output=False,
                )
                pred_masks_up = F.interpolate(pred_masks, size=(1024, 1024), mode="bilinear", align_corners=False)
                batch_loss = batch_loss + combined_loss(pred_masks_up, masks[b:b+1])
            batch_loss = batch_loss / B

            optimizer.zero_grad()
            batch_loss.backward()
            optimizer.step()
            train_loss += batch_loss.item()

        train_loss /= max(len(train_dl), 1)

        if use_val:
            # Validation
            model.eval()
            val_dice = 0.0
            with torch.no_grad():
                for imgs, masks, pt_coords, pt_labels in val_dl:
                    imgs = imgs.to(device)
                    masks = masks.to(device)
                    pt_coords = pt_coords.to(device)
                    pt_labels = pt_labels.to(device)

                    img_embs = model.image_encoder(imgs)
                    B = imgs.shape[0]
                    for b in range(B):
                        sparse_emb, dense_emb = model.prompt_encoder(
                            points=(pt_coords[b:b+1], pt_labels[b:b+1]), boxes=None, masks=None
                        )
                        pred_masks, _ = model.mask_decoder(
                            image_embeddings=img_embs[b:b+1],
                            image_pe=model.prompt_encoder.get_dense_pe(),
                            sparse_prompt_embeddings=sparse_emb,
                            dense_prompt_embeddings=dense_emb,
                            multimask_output=False,
                        )
                        pred_masks_up = F.interpolate(pred_masks, size=(1024, 1024), mode="bilinear", align_corners=False)
                        pred_bin = (torch.sigmoid(pred_masks_up) > 0.5).float()
                        inter = (pred_bin * masks[b:b+1]).sum()
                        union = pred_bin.sum() + masks[b:b+1].sum()
                        val_dice += (2 * inter / (union + 1e-6)).item()

            val_dice /= max(len(val_dl) * batch_size, 1)  # normalise per-image not per-batch
            _dur = _time.time() - _ep_start
            _epoch_durations.append(_dur)
            _avg = sum(_epoch_durations) / len(_epoch_durations)
            _eta = _avg * (num_epochs - epoch)
            _h, _m = int(_eta // 3600), int((_eta % 3600) // 60)
            log(f"Epoch {epoch}/{num_epochs}  train_loss={train_loss:.4f}  val_dice={val_dice:.4f}"
                f"  [{int(_dur)}s/epoch  ETA {_h}h {_m:02d}m]")

            if val_dice > best_val_dice:
                best_val_dice = val_dice
                torch.save(model.state_dict(), best_ckpt_path)
                log(f"  => Saved best checkpoint (val_dice={best_val_dice:.4f})")
        else:
            _dur = _time.time() - _ep_start
            _epoch_durations.append(_dur)
            _avg = sum(_epoch_durations) / len(_epoch_durations)
            _eta = _avg * (num_epochs - epoch)
            _h, _m = int(_eta // 3600), int((_eta % 3600) // 60)
            log(f"Epoch {epoch}/{num_epochs}  train_loss={train_loss:.4f}"
                f"  [{int(_dur)}s/epoch  ETA {_h}h {_m:02d}m]")
            torch.save(model.state_dict(), best_ckpt_path)

    if use_val:
        log(f"\nTraining complete. Best val Dice: {best_val_dice:.4f}")
    else:
        log(f"\nTraining complete ({num_epochs} epochs, full dataset).")
    log(f"Checkpoint saved to: {best_ckpt_path}")
    return "\n".join(logs)


# ── Phase 3: ONNX Export ───────────────────────────────────────────────────────

def export_onnx(
    checkpoint_path: str,
    medsam_checkpoint: str,
    output_dir: str,
) -> str:
    """
    Phase 3: Export fine-tuned encoder + decoder as separate ONNX files.
    checkpoint_path: best_checkpoint.pth (state dict)
    medsam_checkpoint: original MedSAM-Lite checkpoint (for architecture init)
    output_dir: where to write liver_seg_encoder.onnx and liver_seg_decoder.onnx
    """
    if not HAS_TORCH:
        return "ERROR: PyTorch not installed."

    logs = []
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    logs.append("Loading model…")
    try:
        model = _get_medsam_lite(medsam_checkpoint)
        state = torch.load(checkpoint_path, map_location="cpu")
        model.load_state_dict(state)
        model.eval()
    except Exception as e:
        return f"ERROR loading model: {e}"

    # ── Encoder ─────────────────────────────────────────────────────────────────
    encoder = model.image_encoder
    dummy_img = torch.zeros(1, 6, 1024, 1024)
    encoder_path = out / "liver_seg_encoder.onnx"
    logs.append("Exporting encoder…")
    try:
        torch.onnx.export(
            encoder,
            dummy_img,
            str(encoder_path),
            input_names=["image"],
            output_names=["embedding"],
            opset_version=17,
            dynamic_axes={"image": {0: "batch"}},
            dynamo=False,
        )
        logs.append(f"  Encoder → {encoder_path}")
    except Exception as e:
        logs.append(f"  ERROR exporting encoder: {e}")
        return "\n".join(logs)

    # ── Decoder ─────────────────────────────────────────────────────────────────
    # SAM's mask_decoder.predict_masks uses torch.repeat_interleave with a dynamic
    # repeat count (tokens.shape[0]), which ONNX exports as a Tile op whose output
    # shape ONNX Runtime can't statically infer → ShapeInferenceError.
    # Fix: monkey-patch predict_masks to use expand() instead, which is ONNX-friendly
    # and equivalent for our batch=1 use case.
    import types

    def _predict_masks_onnx_safe(
        self, image_embeddings, image_pe,
        sparse_prompt_embeddings, dense_prompt_embeddings,
    ):
        output_tokens = torch.cat([self.iou_token.weight, self.mask_tokens.weight], dim=0)
        output_tokens = output_tokens.unsqueeze(0).expand(sparse_prompt_embeddings.size(0), -1, -1)
        tokens = torch.cat((output_tokens, sparse_prompt_embeddings), dim=1)
        # Hardcode batch=1: skip repeat/expand entirely so all tensor sizes are
        # statically known to ONNX (avoids ShapeInferenceError from dynamic Tile op)
        src     = image_embeddings + dense_prompt_embeddings
        pos_src = image_pe
        b, c, h, w = image_embeddings.shape
        hs, src = self.transformer(src, pos_src, tokens)
        iou_token_out   = hs[:, 0, :]
        mask_tokens_out = hs[:, 1:(1 + self.num_mask_tokens), :]
        src = src.transpose(1, 2).view(b, c, h, w)
        upscaled = self.output_upscaling(src)
        hyper_in = torch.stack(
            [self.output_hypernetworks_mlps[i](mask_tokens_out[:, i, :])
             for i in range(self.num_mask_tokens)], dim=1
        )
        b, c, h, w = upscaled.shape
        masks    = (hyper_in @ upscaled.view(b, c, h * w)).view(b, -1, h, w)
        iou_pred = self.iou_prediction_head(iou_token_out)
        return masks, iou_pred

    model.mask_decoder.predict_masks = types.MethodType(_predict_masks_onnx_safe, model.mask_decoder)

    # PromptEncoder._embed_points uses boolean indexing (point_embedding[labels==-1])
    # which ONNX exports as NonZero+Gather → dynamic shapes → ShapeInferenceError.
    # Replace with torch.where which produces statically-shaped tensors.
    def _embed_points_onnx_safe(self, points, labels, pad):
        points = points + 0.5
        if pad:
            padding_point = torch.zeros((points.shape[0], 1, 2), device=points.device)
            padding_label = -torch.ones((labels.shape[0], 1), device=labels.device)
            points = torch.cat([points, padding_point], dim=1)
            labels = torch.cat([labels, padding_label], dim=1)
        point_embedding = self.pe_layer.forward_with_coords(points, self.input_image_size)
        mask_pad = (labels == -1).unsqueeze(-1)
        mask_neg = (labels ==  0).unsqueeze(-1)
        mask_pos = (labels ==  1).unsqueeze(-1)
        not_a_pt = self.not_a_point_embed.weight.expand_as(point_embedding)
        neg_emb   = self.point_embeddings[0].weight.expand_as(point_embedding)
        pos_emb   = self.point_embeddings[1].weight.expand_as(point_embedding)
        zeros = torch.zeros_like(point_embedding)
        point_embedding = torch.where(mask_pad, not_a_pt, point_embedding)
        point_embedding = point_embedding + torch.where(mask_neg, neg_emb, zeros)
        point_embedding = point_embedding + torch.where(mask_pos, pos_emb, zeros)
        return point_embedding

    model.prompt_encoder._embed_points = types.MethodType(_embed_points_onnx_safe, model.prompt_encoder)

    class DecoderWrapper(nn.Module):
        def __init__(self, model):
            super().__init__()
            self.prompt_encoder = model.prompt_encoder
            self.mask_decoder   = model.mask_decoder

        def forward(self, image_embeddings, point_coords, point_labels):
            sparse_emb, dense_emb = self.prompt_encoder(
                points=(point_coords, point_labels), boxes=None, masks=None
            )
            masks, iou = self.mask_decoder(
                image_embeddings=image_embeddings,
                image_pe=self.prompt_encoder.get_dense_pe(),
                sparse_prompt_embeddings=sparse_emb,
                dense_prompt_embeddings=dense_emb,
                multimask_output=False,
            )
            return masks, iou

    decoder_wrapper = DecoderWrapper(model)
    decoder_wrapper.eval()

    with torch.no_grad():
        dummy_emb    = encoder(dummy_img)
    dummy_pts    = torch.zeros(1, 2, 2)   # 1 batch, 2 points, (x,y)
    dummy_labels = torch.zeros(1, 2)      # point labels

    decoder_path = out / "liver_seg_decoder.onnx"
    logs.append("Exporting decoder…")
    try:
        torch.onnx.export(
            decoder_wrapper,
            (dummy_emb, dummy_pts, dummy_labels),
            str(decoder_path),
            input_names=["image_embeddings", "point_coords", "point_labels"],
            output_names=["masks", "iou_predictions"],
            opset_version=17,
            dynamo=False,
        )
        logs.append(f"  Decoder → {decoder_path}")
    except Exception as e:
        logs.append(f"  ERROR exporting decoder: {e}")
        return "\n".join(logs)

    # Simplify both ONNX graphs: constant-folds dynamic ops (Tile, NonZero, etc.)
    # that cause ShapeInferenceError in ONNX Runtime.
    logs.append("Simplifying ONNX graphs…")
    try:
        import onnx
        import onnxsim
        for p, input_shapes in [
            (encoder_path, {"image": [1, 6, 1024, 1024]}),
            (decoder_path, {"image_embeddings": [1, 256, 64, 64],
                            "point_coords": [1, 2, 2],
                            "point_labels": [1, 2]}),
        ]:
            m = onnx.load(str(p))
            m_sim, ok = onnxsim.simplify(m, overwrite_input_shapes=input_shapes)
            if ok:
                onnx.save(m_sim, str(p))
                logs.append(f"  Simplified OK: {p.name}")
            else:
                logs.append(f"  WARNING: simplification failed for {p.name} — using original")
    except Exception as e:
        logs.append(f"  WARNING: onnxsim failed ({e}) — models saved without simplification")

    logs.append("\nONNX export complete.")
    logs.append("Copy both .onnx files to public/models/ in the annotator repo.")
    return "\n".join(logs)


# ── MedSAM-Lite checkpoint download helper ────────────────────────────────────

def download_medsam_checkpoint(save_dir: str) -> str:
    """Download MobileSAM checkpoint from HuggingFace."""
    if not HAS_HF:
        return "ERROR: huggingface_hub not installed. Run: pip install huggingface_hub"
    save_dir = Path(save_dir)
    save_dir.mkdir(parents=True, exist_ok=True)
    try:
        path = hf_hub_download(
            repo_id="dhkim2810/MobileSAM",
            filename="mobile_sam.pt",
            local_dir=str(save_dir),
        )
        return f"Downloaded to: {path}"
    except Exception as e:
        return f"ERROR: {e}"


# ── Phase 5: Evaluation helpers ───────────────────────────────────────────────

def _eval_preprocess(img_path: str):
    """Load image → (6-ch tensor (1,6,1024,1024), original uint8 (1024,1024,3))."""
    img = Image.open(img_path).convert("RGB")
    img = img.resize((1024, 1024), Image.BILINEAR)
    original = np.array(img, dtype=np.uint8)
    rgb = original.astype(np.float32) / 255.0
    gray = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    gy = np.gradient(gray, axis=0)
    gx = np.gradient(gray, axis=1)
    mag = np.sqrt(gx**2 + gy**2)
    mx = mag.max()
    sobel = mag / mx if mx > 0 else mag
    xmap = np.tile(np.linspace(0, 1, 1024, dtype=np.float32), (1024, 1))
    ymap = np.tile(np.linspace(0, 1, 1024, dtype=np.float32).reshape(-1, 1), (1, 1024))
    channels = np.stack([rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2], sobel, xmap, ymap], axis=0)
    tensor = torch.from_numpy(channels).unsqueeze(0)
    return tensor, original


def _eval_infer(model, img_tensor, device) -> np.ndarray:
    """Run encoder + center-point decoder → sigmoid probability map (1024,1024)."""
    img_tensor = img_tensor.to(device)
    with torch.no_grad():
        img_emb = model.image_encoder(img_tensor)
        pt_coords = torch.tensor([[[0.5, 0.5]]], dtype=torch.float32, device=device)
        pt_labels = torch.tensor([[1]],           dtype=torch.float32, device=device)
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
        pred_up = F.interpolate(pred_masks, size=(1024, 1024), mode="bilinear", align_corners=False)
    return torch.sigmoid(pred_up[0, 0]).cpu().numpy().astype(np.float32)


def _extract_gt_mask(leus_files: list, image_stem: str, mask_label: str):
    """Search uploaded .leus files for an image matching image_stem and return binary mask."""
    if not leus_files:
        return None
    for lf in leus_files:
        lf_path = lf if isinstance(lf, str) else lf.name
        try:
            with open(lf_path, "r", encoding="utf-8") as f:
                proj = json.load(f)
        except Exception:
            continue
        for img_entry in proj.get("images", []):
            entry_name = img_entry.get("name", "")
            if entry_name != image_stem and Path(entry_name).stem != image_stem:
                continue
            for lbl in img_entry.get("labels", []):
                if lbl.get("name", "") != mask_label:
                    continue
                mask_png = lbl.get("maskPNG")
                if not mask_png:
                    continue
                try:
                    mask_img = _decode_base64_image(mask_png).convert("RGBA")
                    alpha = np.array(mask_img)[:, :, 3]
                    binary = (alpha > 0)
                    mask_pil = Image.fromarray(binary.astype(np.uint8) * 255)
                    mask_pil = mask_pil.resize((1024, 1024), Image.NEAREST)
                    return np.array(mask_pil) > 0
                except Exception:
                    pass
    return None


def _heatmap_overlay(original: np.ndarray, prob_map: np.ndarray) -> np.ndarray:
    """Blend jet colormap heatmap over original image."""
    if HAS_MPL:
        colormap_rgba = _mpl_cm.jet(prob_map)          # (H, W, 4) float [0,1]
        colormap_rgb  = colormap_rgba[:, :, :3]
    else:
        # Fallback: blue→red gradient without matplotlib
        r = prob_map
        b = 1.0 - prob_map
        g = 1.0 - np.abs(prob_map - 0.5) * 2
        colormap_rgb = np.stack([r, g, b], axis=-1)
    orig_f = original.astype(np.float32) / 255.0
    blended = 0.55 * colormap_rgb + 0.45 * orig_f
    return (np.clip(blended, 0, 1) * 255).astype(np.uint8)


def _mask_overlay(original: np.ndarray, binary_mask: np.ndarray,
                  color: tuple = (0, 230, 160)) -> np.ndarray:
    """Blend semi-transparent mask fill over original image."""
    overlay = original.astype(np.float32)
    m = binary_mask.astype(bool)
    for c, val in enumerate(color):
        overlay[:, :, c][m] = 0.60 * overlay[:, :, c][m] + 0.40 * val
    return np.clip(overlay, 0, 255).astype(np.uint8)


def _compute_metrics(pred: np.ndarray, gt: np.ndarray) -> dict:
    tp = float((pred & gt).sum())
    fp = float((pred & ~gt).sum())
    fn = float((~pred & gt).sum())
    return {
        "dice":      2 * tp / (2 * tp + fp + fn + 1e-6),
        "iou":       tp / (tp + fp + fn + 1e-6),
        "precision": tp / (tp + fp + 1e-6),
        "recall":    tp / (tp + fn + 1e-6),
    }


def _build_gallery(state_data: list, threshold: float,
                   show_heatmap: bool, show_mask: bool) -> tuple:
    """Rebuild gallery images and metrics text from cached state."""
    gallery = []
    metric_lines = []

    for entry in state_data:
        name     = entry["name"]
        original = entry["original"]
        prob_map = entry["prob_map"]
        gt_mask  = entry["gt_mask"]

        binary = prob_map > threshold

        gallery.append((original, f"{name}  |  Original"))

        if show_heatmap:
            gallery.append((_heatmap_overlay(original, prob_map),
                             f"{name}  |  Heatmap"))

        if show_mask:
            caption = f"{name}  |  Mask  (t={threshold:.2f})"
            if gt_mask is not None:
                m = _compute_metrics(binary, gt_mask)
                caption += f"  Dice={m['dice']:.3f}  Prec={m['precision']:.3f}"
                metric_lines.append(
                    f"{name:<28} Dice={m['dice']:.3f}  IoU={m['iou']:.3f}"
                    f"  Prec={m['precision']:.3f}  Rec={m['recall']:.3f}"
                )
            gallery.append((_mask_overlay(original, binary), caption))
        elif gt_mask is not None:
            m = _compute_metrics(binary, gt_mask)
            metric_lines.append(
                f"{name:<28} Dice={m['dice']:.3f}  IoU={m['iou']:.3f}"
                f"  Prec={m['precision']:.3f}  Rec={m['recall']:.3f}"
            )

    metrics_text = ""
    if metric_lines:
        n = len(metric_lines)
        all_m = [_compute_metrics(
            entry["prob_map"] > threshold, entry["gt_mask"])
            for entry in state_data if entry["gt_mask"] is not None]
        mean_dice = sum(m["dice"]      for m in all_m) / len(all_m)
        mean_iou  = sum(m["iou"]       for m in all_m) / len(all_m)
        mean_prec = sum(m["precision"] for m in all_m) / len(all_m)
        mean_rec  = sum(m["recall"]    for m in all_m) / len(all_m)
        sep = "-" * 68
        metrics_text = "\n".join(metric_lines) + f"\n{sep}\n" + (
            f"{'Mean':<28} Dice={mean_dice:.3f}  IoU={mean_iou:.3f}"
            f"  Prec={mean_prec:.3f}  Rec={mean_rec:.3f}  (n={n})"
        )

    return gallery, metrics_text


def evaluate_images(
    image_files,
    leus_files,
    checkpoint_path: str,
    medsam_checkpoint: str,
    threshold: float,
    mask_label: str,
    show_heatmap: bool,
    show_mask: bool,
):
    """
    Run inference on uploaded images, cache probability maps, return gallery + state.
    Returns: (gallery, state_data, metrics_text, log_text)
    """
    if not HAS_TORCH:
        empty = []
        return empty, empty, "", "ERROR: PyTorch not installed."
    if not image_files:
        return [], [], "", "No images provided."
    if not Path(checkpoint_path).exists():
        return [], [], "", f"ERROR: checkpoint not found: {checkpoint_path}"
    if not Path(medsam_checkpoint).exists():
        return [], [], "", f"ERROR: MobileSAM checkpoint not found: {medsam_checkpoint}"
    if not HAS_PIL:
        return [], [], "", "ERROR: Pillow not installed."

    logs = []
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    logs.append(f"Device: {device}")

    try:
        model = _get_medsam_lite(medsam_checkpoint)
        state = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
        if not isinstance(state, dict):
            state = state.state_dict()
        model.load_state_dict(state, strict=False)
        model.to(device).eval()
        logs.append("Model loaded.")
    except Exception as e:
        return [], [], "", f"ERROR loading model: {e}"

    state_data = []
    img_paths = [f if isinstance(f, str) else f.name for f in image_files]

    for img_path in img_paths:
        stem = Path(img_path).stem
        try:
            tensor, original = _eval_preprocess(img_path)
            prob_map = _eval_infer(model, tensor, device)
        except Exception as e:
            logs.append(f"  SKIP {stem}: {e}")
            continue

        gt_mask = _extract_gt_mask(leus_files, stem, mask_label)
        gt_note = "  (GT matched)" if gt_mask is not None else ""
        logs.append(f"  OK {stem}{gt_note}")

        state_data.append({
            "name":     stem,
            "original": original,
            "prob_map": prob_map,
            "gt_mask":  gt_mask,
        })

    if not state_data:
        return [], [], "", "\n".join(logs) + "\nNo images processed."

    gallery, metrics_text = _build_gallery(state_data, threshold, show_heatmap, show_mask)
    logs.append(f"\nDone — {len(state_data)} image(s) evaluated.")
    return gallery, state_data, metrics_text, "\n".join(logs)


def rerender_masks(state_data, threshold, show_heatmap, show_mask):
    """Re-apply threshold and overlay toggles to cached probability maps. No re-inference."""
    if not state_data:
        return [], ""
    gallery, metrics_text = _build_gallery(state_data, threshold, show_heatmap, show_mask)
    return gallery, metrics_text


# ── Gradio UI ─────────────────────────────────────────────────────────────────

_CSS = """
/* ── Autoliver Pipeline UI — Dark Theme ─────────────────────────────── */

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
        print("Gradio not installed. Run: pip install gradio")
        sys.exit(1)

    with gr.Blocks(title="Liver EUS Pipeline") as demo:
        gr.Markdown("# Liver EUS Autosegmentation Pipeline")
        gr.Markdown(
            "Five tabs: **Data Prep** → **Train** → **Export ONNX** → **Deploy** → **Evaluate**.\n\n"
            "Run tabs 1–4 in order after collecting annotated `.leus` files. "
            "Use **Evaluate** at any time to inspect model output on fresh images."
        )

        # ── Tab 1: Data Prep ───────────────────────────────────────────────────
        with gr.Tab("1 · Data Prep"):
            gr.Markdown(
                "Parse `.leus` project files → image + mask PNGs ready for training.\n\n"
                "**Input:** one or more `.leus` files (the app's native save format).\n"
                "**Output:** `images/`, `masks/`, `dataset.json`, `manifest.csv`.\n\n"
                "Images **with** annotations are exported with their liver mask. "
                "Images **without** any annotation are included as **hard negatives** "
                "(all-zero mask) — they teach the model to predict an empty mask "
                "when no liver is present. These cases are logged as `OK (negative)`."
            )
            with gr.Row():
                leus_files  = gr.File(label=".leus files", file_count="multiple", file_types=[".leus"])
                output_dir1 = gr.Textbox(label="Output directory", value="output", scale=1)
            prep_btn = gr.Button("Prepare Dataset", variant="primary")
            prep_log = gr.Textbox(label="Log", lines=20, interactive=False)

            def run_prep(files, out_dir):
                if not files:
                    return "No files selected."
                paths = [f.name for f in files]
                return prepare_dataset(paths, out_dir)

            prep_btn.click(run_prep, inputs=[leus_files, output_dir1], outputs=prep_log)

        # ── Tab 2: Train ───────────────────────────────────────────────────────
        with gr.Tab("2 · Train"):
            gr.Markdown(
                "Fine-tune MobileSAM (TinyViT-5M) on your prepared dataset.\n\n"
                "You need the MobileSAM pretrained checkpoint (`mobile_sam.pt`). "
                "Use the **Download Checkpoint** button below if you don't have one.\n\n"
                "**Epochs** — how many full passes through your dataset the model trains for. "
                "More epochs = more learning, but too many can cause overfitting. 20 is a safe default; increase if val Dice is still improving at the end.\n\n"
                "**Batch size** — how many images are processed together per training step. "
                "Larger batches train faster but use more GPU/CPU memory. Reduce to 1 if you run out of memory."
            )
            with gr.Row():
                dataset_dir_t  = gr.Textbox(label="Dataset directory (from step 1)", value="output")
                medsam_ckpt_t  = gr.Textbox(label="MobileSAM checkpoint path", value="checkpoints/mobile_sam.pt")
            with gr.Row():
                train_out_t    = gr.Textbox(label="Training output directory", value="checkpoints")
                epochs_s       = gr.Slider(label="Epochs", minimum=5, maximum=100, value=20, step=1)
                batch_s        = gr.Slider(label="Batch size", minimum=1, maximum=8, value=2, step=1)
            with gr.Row():
                use_val_cb = gr.Checkbox(label="Validation split (80/20) — uncheck to train on full dataset", value=True)

            with gr.Row():
                dl_dir_t = gr.Textbox(label="Checkpoint save dir (for download)", value="checkpoints", scale=2)
                dl_btn   = gr.Button("Download MobileSAM Checkpoint")
            dl_log = gr.Textbox(label="Download log", lines=2, interactive=False)
            dl_btn.click(download_medsam_checkpoint, inputs=[dl_dir_t], outputs=dl_log)

            train_btn = gr.Button("Start Training", variant="primary")
            train_log = gr.Textbox(label="Training log", lines=25, interactive=False)

            def run_train(ds_dir, ckpt, out_dir, epochs, batch, use_val):
                import threading, queue
                if not HAS_TORCH:
                    yield "ERROR: PyTorch not installed."
                    return
                q     = queue.Queue()
                lines = []

                def on_log(msg):
                    lines.append(msg)
                    q.put(("\n".join(lines), False))

                def worker():
                    try:
                        train_model(ds_dir, ckpt, out_dir, int(epochs), int(batch),
                                    bool(use_val), progress_callback=on_log)
                    except Exception as e:
                        import traceback
                        lines.append(f"ERROR: {e}\n{traceback.format_exc()}")
                    finally:
                        q.put(("\n".join(lines), True))

                threading.Thread(target=worker, daemon=True).start()
                while True:
                    text, done = q.get()
                    yield text
                    if done:
                        break

            train_btn.click(
                run_train,
                inputs=[dataset_dir_t, medsam_ckpt_t, train_out_t, epochs_s, batch_s, use_val_cb],
                outputs=train_log,
            )

        # ── Tab 3: Export ONNX ────────────────────────────────────────────────
        with gr.Tab("3 · Export ONNX"):
            gr.Markdown(
                "Export the fine-tuned model as two ONNX files:\n"
                "- `liver_seg_encoder.onnx` — image encoder (runs once per image)\n"
                "- `liver_seg_decoder.onnx` — mask decoder (runs per click)\n\n"
                "Copy both files to `public/models/` in the annotator repo, then rebuild."
            )
            with gr.Row():
                finetuned_ckpt = gr.Textbox(label="Fine-tuned checkpoint", value="checkpoints/best_checkpoint.pth")
                medsam_ckpt_e  = gr.Textbox(label="MobileSAM base checkpoint", value="checkpoints/mobile_sam.pt")
                onnx_out_dir   = gr.Textbox(label="ONNX output directory", value="onnx_export")
            export_btn = gr.Button("Export ONNX", variant="primary")
            export_log = gr.Textbox(label="Log", lines=15, interactive=False)

            export_btn.click(
                export_onnx,
                inputs=[finetuned_ckpt, medsam_ckpt_e, onnx_out_dir],
                outputs=export_log,
            )

        # ── Tab 4: Deploy ─────────────────────────────────────────────────────
        with gr.Tab("4 · Deploy"):
            gr.Markdown(
                "Copy ONNX files into the annotator and rebuild.\n\n"
                "Provide the path to the annotator repo root and the ONNX export directory."
            )
            with gr.Row():
                annotator_root = gr.Textbox(label="Annotator repo root", value=str(Path(__file__).resolve().parent.parent))
                onnx_src_dir   = gr.Textbox(label="ONNX export directory", value="onnx_export")
            deploy_btn = gr.Button("Copy .onnx files to public/models/", variant="primary")
            deploy_log = gr.Textbox(label="Log", lines=8, interactive=False)

            def run_deploy(repo_root, onnx_dir):
                logs = []
                src = Path(onnx_dir)
                dst = Path(repo_root) / "public" / "models"
                dst.mkdir(parents=True, exist_ok=True)
                for fname in ["liver_seg_encoder.onnx", "liver_seg_decoder.onnx"]:
                    s = src / fname
                    d = dst / fname
                    if not s.exists():
                        logs.append(f"MISSING: {s}")
                        continue
                    shutil.copy2(s, d)
                    logs.append(f"Copied {fname} → {d}")
                if all((dst / f).exists() for f in ["liver_seg_encoder.onnx", "liver_seg_decoder.onnx"]):
                    logs.append("\nBoth models deployed. Run 'npm run dev' or 'npm run build' in the annotator to activate ML autosegmentation.")
                return "\n".join(logs)

            deploy_btn.click(run_deploy, inputs=[annotator_root, onnx_src_dir], outputs=deploy_log)

        # ── Tab 5: Evaluate ───────────────────────────────────────────────────
        with gr.Tab("5 · Evaluate"):
            gr.Markdown(
                "Run the trained model on fresh images and inspect the probability heatmap "
                "and binary mask overlay. Probability maps are cached after inference — "
                "adjusting the threshold or toggling overlays updates the view instantly "
                "without re-running the model.\n\n"
                "Optionally upload `.leus` files alongside images to compute "
                "Dice / IoU / Precision / Recall against ground-truth annotations."
            )
            with gr.Row():
                eval_images = gr.File(label="Images (PNG / JPG)", file_count="multiple",
                                      file_types=[".png", ".jpg", ".jpeg"])
                eval_leus   = gr.File(label="Ground truth .leus files (optional)",
                                      file_count="multiple", file_types=[".leus"])
                eval_ckpt   = gr.Textbox(label="Fine-tuned checkpoint",
                                         value="checkpoints/best_checkpoint.pth")
                eval_medsam = gr.Textbox(label="MobileSAM checkpoint",
                                         value="checkpoints/mobile_sam.pt")
            with gr.Row():
                eval_thresh     = gr.Slider(label="Sigmoid threshold", minimum=0.30,
                                            maximum=0.80, step=0.05, value=0.55)
                eval_mask_label = gr.Textbox(label="Mask type label", value="Liver")
            with gr.Row():
                show_heatmap = gr.Checkbox(label="Show heatmap overlay",  value=True)
                show_mask    = gr.Checkbox(label="Show mask overlay",      value=True)

            eval_btn     = gr.Button("Run Evaluation", variant="primary")
            eval_state   = gr.State([])
            eval_gallery = gr.Gallery(label="Results — Original / Heatmap / Mask per image",
                                      columns=3, object_fit="contain", height="auto")
            eval_metrics = gr.Textbox(label="Metrics (when ground truth provided)",
                                      lines=8, interactive=False)
            eval_log     = gr.Textbox(label="Log", lines=6, interactive=False)

            eval_btn.click(
                evaluate_images,
                inputs=[eval_images, eval_leus, eval_ckpt, eval_medsam,
                        eval_thresh, eval_mask_label, show_heatmap, show_mask],
                outputs=[eval_gallery, eval_state, eval_metrics, eval_log],
            )

            # Re-render on threshold or toggle change — no re-inference
            for trigger in [eval_thresh, show_heatmap, show_mask]:
                trigger.change(
                    rerender_masks,
                    inputs=[eval_state, eval_thresh, show_heatmap, show_mask],
                    outputs=[eval_gallery, eval_metrics],
                )

    return demo


# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7860)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    demo = build_ui()
    demo.launch(server_port=args.port, inbrowser=not args.no_browser, css=_CSS)
