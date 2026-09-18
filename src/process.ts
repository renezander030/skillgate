import { spawnSync } from "node:child_process";

export interface CommandExecution {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: Error;
}

// Run the user's shell command behind a tiny Node supervisor. On Unix the child
// starts a new process group so timeout cleanup reaps grandchildren too. Windows
// uses taskkill /T when available and falls back to terminating the shell child.
const SUPERVISOR = String.raw`
const { spawn } = require("node:child_process");
const command = process.argv[1];
const cwd = process.argv[2];
const timeout = Number(process.argv[3]);
const windows = process.platform === "win32";
const child = spawn(command, { cwd, shell: true, detached: !windows, stdio: "inherit" });
let expired = false;
const timer = setTimeout(() => {
  expired = true;
  if (windows && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    killer.once("error", () => { try { child.kill("SIGKILL"); } catch {} });
  } else if (child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}, timeout);
child.once("error", error => { clearTimeout(timer); console.error(error.message); process.exit(126); });
child.once("exit", (code, signal) => {
  clearTimeout(timer);
  if (expired) process.exit(124);
  if (signal) process.exit(128);
  process.exit(code == null ? 1 : code);
});
`;

export function runShellCommand(command: string, cwd: string, timeout: number): CommandExecution {
  const result = spawnSync(process.execPath, ["-e", SUPERVISOR, command, cwd, String(timeout)], {
    cwd,
    encoding: "utf8",
    timeout: timeout + 5_000,
    killSignal: "SIGKILL",
    maxBuffer: 10 * 1024 * 1024,
  });
  const error = result.error as Error & { code?: string } | undefined;
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    timedOut: result.status === 124 || result.signal === "SIGKILL" || error?.code === "ETIMEDOUT",
    error,
  };
}
