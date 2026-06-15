# Self-hosted gate — put the evaluator outside the AI agent

## The idea, in one sentence

**The thing that decides "is this done?" must run somewhere your AI coding agent
cannot reach or edit.**

Here's why that matters. skillgate checks a change against a *definition of done*
before it's allowed through. If that check runs on the same machine as the agent,
at the agent's privilege level, then the agent can defeat it the same way it would
defeat any local rule:

- skip it (`git push --no-verify` skips client-side hooks),
- edit the check (rewrite the hook script),
- or move the goalposts (edit `done.yaml` so the unfinished work now "passes").

A local hook is a reminder, not a guarantee. To get a guarantee you move the
evaluator *off the agent's reach* — onto a separate machine, VM, or container that
the agent can only talk to through a narrow channel (`git push`), never log into.
Then the agent can propose a change, but something it doesn't control decides
whether the change is done. That is the whole trick.

```
┌─ your machine (the AI agent) ─┐  git push   ┌─ the evaluator (agent can't enter) ─┐
│  can edit code                │ ──────────▶ │  bare repo + pre-receive hook:      │
│  can run --no-verify          │   (ssh)     │    skillgate check  vs  the PINNED   │
│  CANNOT edit the hook         │ ◀────────── │    done.yaml that lives HERE         │
│  CANNOT edit done.yaml        │ accept/deny │  → reject the push, or accept it     │
└───────────────────────────────┘             └──────────────────────────────────────┘
```

It also closes a real gap: GitHub's own "hard" layer (CI + branch protection)
**isn't enforced on private repos under a Free personal account**, so a lot of solo
and private projects can't use it. This gives you the same guarantee for free, on a
box you control.

## What makes it actually hard (two invariants)

Get these two right and the substrate barely matters:

1. **The agent can't edit the evaluator.** The definition of done and the hook live
   on the box; the `gate` user's shell is `git-shell`, so a push can't turn into a
   login. The hook also restores the box's pinned `done.yaml` over whatever was
   pushed, so the policy can't be smuggled in through the tree.
2. **The agent doesn't hold the upstream push credential.** This is the load-bearing
   one. If the agent can push to GitHub directly, it bypasses the gate no matter how
   it's hosted. Put the upstream write key only on the gate box and let
   `post-receive` mirror accepted pushes (see *Mirror to upstream* below).

## Pick a substrate by how well your agent is already sandboxed

The boundary can be anything the agent's privileges don't extend into. Stronger
sandboxing of the agent lets you use a lighter gate.

| Substrate | Boundary | Use when | Recipe |
|---|---|---|---|
| **Remote VPS** | Strongest — a separate machine, no login for the agent | you want the CI-grade guarantee | [`vps/`](vps/) |
| **VM (VirtualBox + Vagrant)** | Strong — separate kernel, local, free, offline | no server, no cloud account | this dir ([below](#vm-virtualbox--vagrant)) |
| **Docker container** | Good *if* the agent has no Docker socket and no creds | you already run containers | [`docker/`](docker/) |
| Another local folder, same user | **None** — the agent can edit it | (don't; it's just a client hook) | — |

All three real options run the *same* `pre-receive` gate and the *same* shared
installer ([`gate-install.sh`](gate-install.sh)); only "make the box" and "start
sshd" differ.

## VM (VirtualBox + Vagrant)

```sh
cd contrib/self-hosted-gate
cp /path/to/your/.skillgate/done.yaml ./done.yaml     # or let provision init one
cp ~/.ssh/id_ed25519.pub ./authorized_key.pub          # the key you'll push with
vagrant up                                             # builds the Alpine gate VM
# from your repo:
git remote add gate ssh://gate@127.0.0.1:2222/srv/repos/repo.git
git push gate main      # rejected unless `skillgate check` passes
```

No Vagrant? `provision.sh` is a plain Alpine script — make a VirtualBox VM with a
NAT port-forward (host 2222 → guest 22), copy `pre-receive`, `post-receive`,
`done.yaml` into `/tmp`, and run it as root. [`TESTING.md`](TESTING.md) has a
portable end-to-end test (clean push accepted, violating push rejected).

Other hypervisors (KVM, Hyper-V, VMware, ESXi/vSphere, XCP-ng, bhyve, WSL2) are a
labelled community follow-up rather than shipped here, so this stays to paths that
are tested end-to-end.

## Mirror to upstream (makes it the only path to GitHub)

1. Get the gate box's deploy key: it's printed at provision time, or
   `cat ~gate/.ssh/id_ed25519.pub` on the box (`docker compose logs gate` for the
   container).
2. GitHub repo → Settings → Deploy keys → add it with **write** access.
3. Set `SKILLGATE_UPSTREAM=git@github.com:you/repo.git` in the `post-receive`
   environment on the box.
4. Remove the agent's own GitHub push ability. Now nothing ungated reaches GitHub.

## Notes

- `command`-type gates (e.g. `npm test`) run the *pushed tree's code* on the gate
  box, so it needs your build deps. Filesystem gates (file-exists / contains /
  absent / evidence) need nothing.
- **Threat model for `command`-type gates plus the upstream mirror.** A `command`
  gate executes pushed code on the box. If that same box also holds the upstream
  deploy key, a malicious push can read `~gate/.ssh/id_ed25519` and push upstream
  directly, defeating the gate. So use **filesystem-only** gates when the box also
  mirrors to upstream, or keep the upstream credential off the box.
- The skillgate version the hook runs is pinned (`SKILLGATE_VERSION`, default
  `0.1.0`) so a push can't pull a different package off npm than the box was built
  with.
- The pinned `done.yaml` is updated by re-provisioning — a deliberate admin action,
  not something the agent can do.
