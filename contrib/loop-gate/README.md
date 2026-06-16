# Loop + gate — a retry loop that actually stops

A retry loop (the "Ralph" pattern) re-runs an agent until it declares itself finished. Left alone, its stop condition is the model's own claim that it's done — the exact signal [the Compliance Gap](../../README.md#this-is-a-measured-structural-failure-not-a-vibe) shows you cannot trust. The agent says done, the loop exits, the deviation ships.

`loop-until-done.sh` flips the stop condition: a deterministic `skillgate check`, not the model, decides each round is or isn't done.

```bash
./loop-until-done.sh --max 8 -- opencode run "make the failing skillgate gates pass"
./loop-until-done.sh -- claude -p "fix whatever skillgate reports, then stop"
```

- Exits **0** only when every gate passes.
- Exits **1** after `--max` rounds (default 10), so a stuck agent can't spin forever.
- The progress command can be anything: an agent, a formatter, a codegen step.

Define "done" once in `.skillgate/done.yaml` (`npx @reneza/skillgate init`). The same file gates your commits, your CI, and this loop.

> Use a loop to make progress. Use the gate to define when progress is allowed to end.
