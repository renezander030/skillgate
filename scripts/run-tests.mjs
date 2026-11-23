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

// A CI pull-request run names the branches of the repository under test (GITHUB_BASE_REF and its GitLab/Bitbucket
// twins, GITHUB_HEAD_REF, GITHUB_REF_NAME). Skillgate judges a pull request against that target branch, so in the
// tests every throwaway fixture repo, which has neither branch, failed closed: release 0.16.1, PR #62, 41 of 275
// tests on every OS. The tests run without them; SKILLGATE_BASE too, as a test sets it where it means it.
export const CI_REPO_VARS = [
  "GITHUB_BASE_REF",
  "GITHUB_HEAD_REF",
  "GITHUB_REF_NAME",
  "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
  "BITBUCKET_PR_DESTINATION_BRANCH",
  "SKILLGATE_BASE",
];
const env = { ...process.env };
for (const name of CI_REPO_VARS) delete env[name];

const result = spawnSync(process.execPath, [...process.argv.slice(2), "--test", ...files], {
  stdio: "inherit",
  env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
