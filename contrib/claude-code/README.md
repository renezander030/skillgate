# Claude Code — definition-of-done hook kit

Make Claude Code unable to `git commit` / `git push` / `npm publish` until your gates pass. The model can propose the command; this hook denies it and feeds the failing gates back into the same session, so Claude fixes the work instead of shipping it.

## Setup (about 60 seconds)

From your project root:

```bash
mkdir -p .claude .skillgate

# 1. the hook
cp <skillgate>/contrib/claude-code/skillgate-hook.sh .claude/skillgate-hook.sh
chmod +x .claude/skillgate-hook.sh

# 2. a definition of done (copy the starter, or generate one)
cp <skillgate>/contrib/claude-code/done.yaml .skillgate/done.yaml
#   or:  npx @reneza/skillgate init
```

Then merge [`settings.json`](settings.json) from this directory into your `.claude/settings.json` (create the file if it doesn't exist). Start Claude Code and try to commit unfinished work — the commit is blocked until the gates pass.

## What it does

- Fires on every Bash tool call (`PreToolUse`).
- Ignores everything except finish-line commands (commit / push / publish).
- On a finish-line command it runs `skillgate check`:
  - all gates pass → the command is allowed through;
  - any gate fails → the command is denied (exit 2) and the gate report is returned to Claude, in the same session.

## Files

| File | Goes to | Purpose |
|---|---|---|
| `skillgate-hook.sh` | `.claude/skillgate-hook.sh` | the hook script |
| `settings.json` | merge into `.claude/settings.json` | registers the hook |
| `done.yaml` | `.skillgate/done.yaml` | your definition of done |

Edit `done.yaml` to match your project. The same file is reused verbatim by pre-commit, CI, and the opencode adapter — define done once, enforce it everywhere.
