import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDirectory = new URL("../dist/test/", import.meta.url);
const files = readdirSync(testDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => fileURLToPath(new URL(entry.name, testDirectory)))
  .sort();

if (!files.length) {
  console.error("no compiled test files found; run npm run build first");
  process.exit(1);
}

const result = spawnSync(process.execPath, [...process.argv.slice(2), "--test", ...files], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
