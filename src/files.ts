import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WriteOptions {
  /** Write through a symbolic link to the existing regular file it names, keeping the link. */
  followSymlink?: boolean;
}

/**
 * The file a configuration write lands in: `file` itself, or with `followSymlink` the
 * existing regular file its link resolves to. A dangling link or one to a non-file is refused.
 */
function writeTarget(file: string, opts: WriteOptions): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error: any) {
    if (error?.code === "ENOENT") return file;
    throw error;
  }
  if (stat.isFile()) return file;
  if (!stat.isSymbolicLink()) throw new Error(`refusing to replace a non-regular configuration: ${file}`);
  if (!opts.followSymlink) throw new Error(`refusing to replace a non-regular configuration: ${file} is a symbolic link (pass --follow-symlinks to write through it)`);
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new Error(`refusing to write through a dangling symbolic link: ${file}`);
    throw error;
  }
  if (!fs.statSync(real).isFile()) throw new Error(`refusing to write through a symbolic link to a non-regular file: ${file} -> ${real}`);
  return real;
}

/** Replace one complete configuration, preserving the old file on failure. */
export function writeTextAtomic(file: string, text: string, opts: WriteOptions = {}): void {
  file = writeTarget(file, opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    mode = fs.lstatSync(file).mode & 0o777;
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
