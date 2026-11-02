// The two custom URL schemes the renderer reads case files through:
//   endoseg-frame://frame/<ref>/<source>/<file>  — one frame PNG (lazy, not base64)
//   endoseg-video://video/<ref>                  — the intake video, with byte ranges
// Both are read-only.

import { protocol } from "electron";
import { promises as fs, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import * as path from "node:path";
import { projectDir } from "../src/node/library.js";
import { readIntakeRecord } from "../src/node/phases.js";
import { resolveFramePath } from "../src/node/segmentation.js";

export interface CaseLocation {
  baseDir: string;
  id: string;
}

/** Must run before app "ready". */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "endoseg-frame",
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
    {
      scheme: "endoseg-video",
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

let frameServeCount = 0;

/** Install the handlers (after app "ready"). `resolve` turns an untrusted ref into a case. */
export function handleSchemes(resolve: (ref: string) => CaseLocation | null): void {
  protocol.handle("endoseg-frame", async (req) => {
    try {
      const u = new URL(req.url);
      const parts = u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
      const [ref, source, filename] = parts;
      const p = ref ? resolve(ref) : null;
      const abs = p ? resolveFramePath(p.baseDir, p.id, source, filename) : null;
      if (!abs) {
        console.warn(`[seg] frame 404 (bad path) ${req.url}`);
        return new Response("not found", { status: 404 });
      }
      const data = await fs.readFile(abs);
      frameServeCount += 1;
      if (frameServeCount <= 3 || frameServeCount % 25 === 0) {
        console.log(`[seg] frame served #${frameServeCount} ${filename} (${data.length} bytes)`);
      }
      return new Response(new Uint8Array(data), {
        headers: { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" },
      });
    } catch (err) {
      console.error(`[seg] frame error ${req.url}:`, err instanceof Error ? err.message : err);
      return new Response("error", { status: 500 });
    }
  });

  // Byte ranges are honoured so the <video> element can seek without reading the whole file.
  protocol.handle("endoseg-video", async (req) => {
    try {
      const p = resolve(decodeURIComponent(new URL(req.url).pathname.split("/").filter(Boolean)[0] ?? ""));
      const intake = p ? await readIntakeRecord(p.baseDir, p.id) : null;
      const rel = intake?.playbackFile;
      if (!p || !rel || rel.includes("..")) return new Response("not found", { status: 404 });
      const abs = path.join(projectDir(p.baseDir, p.id), "00_intake", rel);
      const size = (await fs.stat(abs)).size;
      const ext = path.extname(abs).toLowerCase();
      const type = ext === ".webm" ? "video/webm" : ext === ".mov" ? "video/quicktime" : "video/mp4";
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
      let start = 0;
      let end = size - 1;
      if (m) {
        if (m[1]) {
          start = Number(m[1]);
          if (m[2]) end = Math.min(Number(m[2]), size - 1);
        } else if (m[2]) {
          start = Math.max(0, size - Number(m[2])); // suffix range: last N bytes
        }
        if (start > end || start >= size) {
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
        }
      }
      const body = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream;
      return new Response(body, {
        status: m ? 206 : 200,
        headers: {
          "Content-Type": type,
          "Content-Length": String(end - start + 1),
          "Accept-Ranges": "bytes",
          ...(m ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
        },
      });
    } catch (err) {
      console.error(`[phases] video error ${req.url}:`, err instanceof Error ? err.message : err);
      return new Response("error", { status: 500 });
    }
  });
}
