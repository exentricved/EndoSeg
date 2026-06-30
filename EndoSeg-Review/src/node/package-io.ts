// .endoseg package extraction and repacking.
import AdmZip from "adm-zip";
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Extract a .endoseg zip to a fresh temp directory and return that path. */
export async function extractPackage(zipPath: string): Promise<string> {
  const workingDir = path.join(os.tmpdir(), `endoseg-review-${Date.now()}`);
  await fs.mkdir(workingDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(workingDir, true);
  return workingDir;
}

/** Re-zip the working directory back to destPath as a .endoseg archive. */
export function savePackage(workingDir: string, destPath: string): void {
  const zip = new AdmZip();

  // Root files
  for (const name of ["project.json", "annotations.leus", "review.db"]) {
    const p = path.join(workingDir, name);
    if (fsSync.existsSync(p)) zip.addFile(name, fsSync.readFileSync(p));
  }

  // frames/
  addDir(zip, path.join(workingDir, "frames"), "frames");

  // masks/
  addDir(zip, path.join(workingDir, "masks"), "masks");

  zip.writeZip(destPath);
}

function addDir(zip: AdmZip, dir: string, prefix: string): void {
  try {
    const files = fsSync.readdirSync(dir);
    for (const f of files) {
      const full = path.join(dir, f);
      if (fsSync.statSync(full).isFile()) {
        zip.addFile(`${prefix}/${f}`, fsSync.readFileSync(full));
      }
    }
  } catch { /* dir may not exist */ }
}

/**
 * Save the annotation snapshot + mask PNGs to the working directory.
 * Mirrors the logic in the main app's saveSegmentationSnapshot.
 */
export async function saveAnnotationsToWorkingDir(
  workingDir: string,
  snapshot: unknown,
): Promise<{ frameCount: number; maskCount: number }> {
  const seg = snapshot as {
    version: number;
    frames: Array<{
      frameId: string;
      name: string;
      label_masks?: Record<string, string>;
    }>;
  };

  if (!seg || seg.version !== 1 || !Array.isArray(seg.frames)) {
    return { frameCount: 0, maskCount: 0 };
  }

  // Write annotations.leus
  await fs.writeFile(
    path.join(workingDir, "annotations.leus"),
    JSON.stringify(snapshot, null, 2),
    "utf8",
  );

  // Rebuild masks/
  const masksDir = path.join(workingDir, "masks");
  try { await fs.rm(masksDir, { recursive: true, force: true }); } catch { /* ignore */ }
  await fs.mkdir(masksDir, { recursive: true });

  let maskCount = 0;
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);

  for (const frame of seg.frames) {
    if (!frame.label_masks) continue;
    for (const [classIdStr, dataUrl] of Object.entries(frame.label_masks)) {
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) continue;
      const base64 = dataUrl.split(",")[1];
      if (!base64) continue;
      const fname = `${sanitize(frame.name)}__class${classIdStr}.png`;
      await fs.writeFile(path.join(masksDir, fname), Buffer.from(base64, "base64"));
      maskCount++;
    }
  }

  return { frameCount: seg.frames.length, maskCount };
}
