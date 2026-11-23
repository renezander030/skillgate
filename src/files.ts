import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WriteOptions {
  /** Write through a symbolic link to the existing regular file it names, keeping the link. */
  followSymlink?: boolean;
}

/**
 * Where a configuration write lands and the permissions it keeps: `file` itself, or with
 * `followSymlink` the existing regular file its link resolves to. A new file gets 0600. A
 * dangling link, a link to a non-file, or any other non-regular path is refused.
 */
function writeTarget(file: string, opts: WriteOptions): { file: string; mode: number } {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { file, mode: 0o600 };
    throw error;
  }
  if (stat.isFile()) return { file, mode: stat.mode & 0o777 };
  if (!stat.isSymbolicLink()) throw new Error(`refusing to replace a non-regular configuration: ${file}`);
  if (!opts.followSymlink) throw new Error(`refusing to replace a non-regular configuration: ${file} is a symbolic link (pass --follow-symlinks to write through it)`);
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new Error(`refusing to write through a dangling symbolic link: ${file}`);
    throw error;
  }
  const target = fs.statSync(real);
  if (!target.isFile()) throw new Error(`refusing to write through a symbolic link to a non-regular file: ${file} -> ${real}`);
  return { file: real, mode: target.mode & 0o777 };
}

/** Replace one complete configuration, preserving the old file on failure. */
export function writeTextAtomic(requested: string, text: string, opts: WriteOptions = {}): void {
  const { file, mode } = writeTarget(requested, opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
