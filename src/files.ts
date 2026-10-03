import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Replace one complete configuration, preserving the old file on failure. */
export function writeTextAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`refusing to replace a non-regular configuration: ${file}`);
    mode = stat.mode & 0o777;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode, flag: "wx" });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Serialize Skillgate installers for one real project root. Never break a live lock. */
export function withInstallLock<T>(root: string, action: () => T): T {
  const identity = crypto.createHash("sha256").update(fs.realpathSync(root)).digest("hex");
  const file = path.join(os.tmpdir(), `skillgate-install-${identity}.lock`);
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error: any) {
    if (error?.code === "EEXIST") throw new Error(`another Skillgate installation holds ${file}; retry after it finishes (remove a stale lock only after confirming the installer stopped)`);
    throw error;
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    return action();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
  }
}
