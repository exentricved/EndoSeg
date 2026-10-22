// Thin promise wrapper around child_process.spawn used for ffmpeg/ffprobe.
import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface BinaryResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Like run(), but captures stdout as raw bytes (for rawvideo pixel output). */
export function runBinary(cmd: string, args: string[], opts: RunOptions = {}): Promise<BinaryResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, cwd: opts.cwd });
    const chunks: Buffer[] = [];
    let stderr = "";
    let buf = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (opts.onStderrLine) {
        buf += s;
        const parts = buf.split(/[\r\n]/);
        buf = parts.pop() ?? "";
        for (const line of parts) if (line.trim()) opts.onStderrLine(line.trim());
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (opts.onStderrLine && buf.trim()) opts.onStderrLine(buf.trim());
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

export interface RunOptions {
  /** Called for each complete stderr line (ffmpeg writes progress to stderr). */
  onStderrLine?: (line: string) => void;
  /** Working directory for the child (lets ffmpeg take relative paths). */
  cwd?: string;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let buf = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (opts.onStderrLine) {
        buf += s;
        // ffmpeg uses \r to update the progress line; treat both as breaks.
        const parts = buf.split(/[\r\n]/);
        buf = parts.pop() ?? "";
        for (const line of parts) if (line.trim()) opts.onStderrLine(line.trim());
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (opts.onStderrLine && buf.trim()) opts.onStderrLine(buf.trim());
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
