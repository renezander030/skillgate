// The tests never see the branches of the repository a CI run builds: skillgate reads them, and a fixture repo has
// none of them (release 0.16.1, PR #62: GITHUB_BASE_REF=master made 41 tests fail closed on every OS).
import test from "node:test";
import assert from "node:assert/strict";

test("a CI run's pull-request branch variables never reach the tests", () => {
  for (const name of ["GITHUB_BASE_REF", "GITHUB_HEAD_REF", "GITHUB_REF_NAME", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
    "BITBUCKET_PR_DESTINATION_BRANCH", "SKILLGATE_BASE"]) {
    assert.equal(process.env[name], undefined, `${name} reached the tests`);
  }
});
