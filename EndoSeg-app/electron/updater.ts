// Auto-update via electron-updater. Wired to whatever publish target is
// configured in electron-builder.yml (GitHub Releases by default). Updates only
// work in the installed/packaged app — in dev the check reports "disabled".
import { autoUpdater } from "electron-updater";
import type { UpdateStatus } from "../src/shared/ipc.js";

let wired = false;

export function setupUpdater(send: (s: UpdateStatus) => void): void {
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => send({ state: "checking" }));
  autoUpdater.on("update-available", (info) =>
    send({ state: "available", version: info.version, message: `Update ${info.version} found — downloading…` }),
  );
  autoUpdater.on("update-not-available", () =>
    send({ state: "not-available", message: "You are on the latest version." }),
  );
  autoUpdater.on("download-progress", (p) =>
    send({ state: "downloading", percent: Math.round(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    send({ state: "downloaded", version: info.version, message: "Update ready — restart to install." }),
  );
  autoUpdater.on("error", (err) =>
    send({ state: "error", message: err instanceof Error ? err.message : String(err) }),
  );
}

export async function checkForUpdates(isPackaged: boolean): Promise<UpdateStatus> {
  if (!isPackaged) {
    return { state: "disabled", message: "Updates are only available in the installed app." };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { state: "checking" };
  } catch (err) {
    return { state: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}
