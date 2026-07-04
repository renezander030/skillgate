# Finish-line gates vs push guards

Most agent-safety tooling gets described as "stop a bad push." That is useful,
but it hides two different product shapes:

- **Push guards** protect one git event. They meet the developer at `git push`,
  inspect what is about to leave the machine, and reject the push when the diff
  violates a policy.
- **Finish-line gates** protect the moment an agent claims work is done. They can
  guard `git commit`, `git push`, `npm publish`, `gh release create`, or any other
  command a workflow treats as crossing the finish line.

Both are valid. They solve different timing problems.

## Where push guards are strongest

A push guard has a sharp user experience: the developer tries to push, the guard
rejects the unsafe state, and the error message points at the concrete thing to
fix. It is easy to explain because the boundary is already familiar. The push is
where code leaves the local workspace.

That makes push guards a good fit for policies such as:

- no secrets in the outgoing diff
- no generated files missing from the commit
- no broken lockfile or dependency state
- no critical vulnerability in the artifact being pushed

The tradeoff is that `git push` is late. By the time a push guard fires, the agent
may already have made a bad commit, written a release note, or told the user the
work is finished.

## Where finish-line gates are stronger

skillgate treats "done" as a workflow boundary, not only a git boundary. The same
`.skillgate/done.yaml` can block any finish-line command:

```yaml
finishLine:
  - "git commit"
  - "git push"
  - "gh release create"
  - "npm publish"

gates:
  - id: tests-pass
    type: command
    run: "npm test --silent"

  - id: trivy-clean
    type: trivy
    severity: ["CRITICAL"]
```

That matters for coding agents. The risky moment is often not the network push;
it is the agent deciding that the task is done and moving on. A finish-line gate
feeds the failing condition back into the same session before the work is
declared complete.

## The practical split

Use a push guard when the policy is mainly about what leaves the repository.
Use a finish-line gate when the policy is about whether the work is actually done.

The best setup uses both:

- a local or agent-layer finish-line gate for fast feedback before `commit`,
  `push`, or `publish`
- a server-side push guard or CI required check for the boundary the agent cannot
  skip

The important part is that the policy stays deterministic. A model can explain
why it thinks the work is fine. A gate has to prove the condition passed.
