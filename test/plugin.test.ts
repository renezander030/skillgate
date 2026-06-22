import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SkillGate } from "../src/plugin.js"

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-plugin-"))
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return dir
}

function bashCall(command: string): [any, any] {
  return [{ tool: "bash" }, { args: { command } }]
}

test("SkillGate returns object with tool.execute.before hook", async (t) => {
  const hooks = await SkillGate({})
  assert.equal(typeof hooks["tool.execute.before"], "function")
})

test("missing .skillgate/ dir: hook does not block", async (t) => {
  const dir = tmpProject({})
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hooks = await SkillGate({ directory: dir })
  await hooks["tool.execute.before"](...bashCall("git commit -m x"))
})

test("finish-line command is allowed when all gates pass", async (t) => {
  const dir = tmpProject({
    "README.md": "hi",
    ".skillgate/done.yaml": [
      "finishLine:",
      "  - git commit",
      "gates:",
      "  - id: readme",
      "    type: file-exists",
      "    file: README.md",
    ].join("\n"),
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hooks = await SkillGate({ directory: dir })
  await hooks["tool.execute.before"](...bashCall("git commit -m 'done'"))
})

test("finish-line command is blocked when a gate fails", async (t) => {
  const dir = tmpProject({
    ".skillgate/done.yaml": [
      "finishLine:",
      "  - git push",
      "gates:",
      "  - id: license",
      "    type: file-exists",
      "    file: LICENSE",
    ].join("\n"),
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hooks = await SkillGate({ directory: dir })
  await assert.rejects(
    () => hooks["tool.execute.before"](...bashCall("git push origin main")),
    { name: "Error", message: /skillgate blocked/ },
  )
})

test("non-bash tool passes through without blocking", async (t) => {
  const dir = tmpProject({
    ".skillgate/done.yaml": [
      "finishLine:",
      "  - git commit",
      "gates:",
      "  - id: always-fail",
      "    type: file-exists",
      "    file: NEVER_EXISTS",
    ].join("\n"),
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hooks = await SkillGate({ directory: dir })
  // input.tool is "read", not "bash" — hook should return early
  await hooks["tool.execute.before"]({ tool: "read" }, { args: { command: "git commit -m x" } })
})

test("non-finish-line command passes through", async (t) => {
  const dir = tmpProject({
    ".skillgate/done.yaml": [
      "finishLine:",
      "  - git push",
      "gates:",
      "  - id: always-fail",
      "    type: file-exists",
      "    file: NEVER_EXISTS",
    ].join("\n"),
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hooks = await SkillGate({ directory: dir })
  // "ls" is not a finish-line command — hook should return early
  await hooks["tool.execute.before"](...bashCall("ls -la"))
})

test("broken spec writes warning to stderr and does not crash", async (t) => {
  const dir = tmpProject({
    ".skillgate/done.yaml": "this is not valid yaml: [[[,,\nbroken",
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hooks = await SkillGate({ directory: dir })
  const chunks: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk: any) => { chunks.push(String(chunk)); return true }
  try {
    await hooks["tool.execute.before"](...bashCall("git commit -m x"))
    const combined = chunks.join("")
    assert.match(combined, /skillgate: warning/)
    assert.match(combined, /spec/)
  } finally {
    process.stderr.write = orig
  }
})