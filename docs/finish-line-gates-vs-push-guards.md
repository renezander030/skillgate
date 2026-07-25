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

## What no-mistakes gets right

[`no-mistakes`](https://github.com/kunchenguid/no-mistakes) makes the push-guard
UX concrete. Its headline is literally `git push no-mistakes`: initialize once,
push to a local `no-mistakes` remote instead of `origin`, and let a post-receive
hook notify a daemon. The daemon then runs the branch through a disposable
worktree pipeline before forwarding it to the configured push target and opening
a PR.

That design has several sharp product choices:

- **The command is memorable.** `git push no-mistakes` names the safety boundary
  at the exact moment the user crosses it.
- **The push returns quickly.** The hook starts the run and tells the user to
  review it, instead of turning the git client into a long-running CI terminal.
- **The real repo stays clean.** The pipeline works in a separate worktree, so
  agent fixes and generated evidence do not trample the developer's checkout.
- **The next action is explicit.** The user can open the TUI, or an agent can
  drive the same flow through `/no-mistakes` / `axi` and respond to parked gates.
- **The push step is a product, not a shell snippet.** It handles fork routing,
  PR creation, CI watching, safe force-push decisions, and fix rounds as one
  coordinated workflow.

That is a strong guard pattern. It turns "please remember to run the checks" into
a named route through which publishable code should travel.

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

The difference is scope. `no-mistakes` owns a whole shipping lane: branch,
worktree, agent fix rounds, PR, and CI. skillgate owns the deterministic predicate:
given this workspace and this definition of done, is the finish line allowed?
That predicate can run inside a Claude Code hook, opencode plugin, pre-commit,
CI, a self-hosted pre-receive hook, or any custom guard that can read an exit
code.

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

The lesson for skillgate is not to imitate the whole shipping lane. It is to make
the finish-line route just as obvious: a named boundary, fast feedback, concrete
failed gates, and one reusable `.skillgate/done.yaml` that every layer can run.
