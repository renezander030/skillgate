# Self-hosted gate — the hard layer, free, for private repos

The main README's **hard** layer is *CI + branch protection*: it runs server-side,
outside the agent's reach. But GitHub **does not enforce branch protection on
private repos under a Free personal account** (it asks you to upgrade to Team/
Enterprise). So for a lot of solo and private projects, the only *hard* layer in the
table is unavailable.

This contrib closes that gap with no paid tier and no cloud: run skillgate as a
**server-side `pre-receive` hook** on a tiny VM (or any box) the agent can't log
into. Two facts make it genuinely hard:

1. **`git push --no-verify` skips *client* hooks only.** A server-side `pre-receive`
   always runs — the agent can't disable it from its side.
2. **The definition of done lives on the box** (`/opt/skillgate/.skillgate/`). The
   agent can push but not SSH in (the `gate` user's shell is `git-shell`), so it
   can't weaken `done.yaml` by editing what it pushes — the hook restores the
   pinned spec before checking.

```
┌─ dev box (the agent) ─┐   git push    ┌─ gate box (VM) ─────────────────────┐
│  remote gate ─────────┼─────────────▶ │  bare repo + pre-receive:           │
│  cannot ssh in        │   (ssh)       │    skillgate check vs the PINNED     │
│  no upstream creds*   │ ◀──────────── │    .skillgate/done.yaml → reject/ok  │
└────────────────────────┘ accept/reject│  post-receive: on PASS, mirror to   │
                                         │    upstream with a box-only key      │
                                         └──────────────────────────────────────┘
```

\* To make it fully agent-proof, the agent must not hold the upstream push
credential — otherwise it can bypass the box by pushing to GitHub directly. Put the
upstream write credential (a deploy key) only on the gate box and have
`post-receive` mirror accepted pushes. Then the box is the sole path to upstream.

## Quick start (free: VirtualBox + Vagrant)

```sh
cd contrib/self-hosted-gate
cp /path/to/your/.skillgate/done.yaml ./done.yaml     # or let provision init one
cp ~/.ssh/id_ed25519.pub ./authorized_key.pub          # the key you'll push with
vagrant up                                             # builds the Alpine gate VM
# from your repo:
git remote add gate ssh://gate@127.0.0.1:2222/srv/repos/repo.git
git push gate main      # rejected unless `skillgate check` passes
```

No Vagrant? `provision.sh` is a plain Alpine script — create a VirtualBox VM with a
NAT port-forward (host 2222 → guest 22), copy `pre-receive`, `post-receive`,
`done.yaml` into `/tmp`, and run it as root.

### Other hypervisors

The gate guest is just an Alpine VM, so it runs on any hypervisor — only VM
creation differs. The provisioner (`provision.sh`) is the single source of truth;
point any VM with root SSH at it. Recipes for KVM, Hyper-V, VMware, ESXi/vSphere,
XCP-ng, bhyve, and WSL2 are tracked as a community follow-up rather than shipped
here, so this contrib stays to the one path that is tested end-to-end (VirtualBox
+ Vagrant).

## Test it end-to-end

[`TESTING.md`](TESTING.md) has a portable one-shot script that boots the VM and
proves a clean push is accepted and a violating push is rejected by the server-side
hook (no machine-specific paths).

## Optional: mirror gate-passed pushes to GitHub

1. `cat ~gate/.ssh/id_ed25519.pub` on the box (also printed at provision time).
2. GitHub repo → Settings → Deploy keys → add it with **write** access.
3. Set `SKILLGATE_UPSTREAM=git@github.com:you/repo.git` in the `post-receive`
   environment (e.g. export it in the gate user's profile, or hardcode in the hook).
4. Drop the agent's direct GitHub push ability. Now nothing ungated reaches GitHub.

## Notes

- `command`-type gates (e.g. `npm test`) run in the pushed tree on the box, so the
  box needs your build deps (add an `npm ci` step to `provision.sh`). Pure
  filesystem gates (file-exists / file-contains / absent / evidence) need nothing.
- **Threat model for `command`-type gates plus the upstream mirror.** A `command`
  gate executes the *pushed tree's code* on the gate box. If that same box also
  holds the upstream deploy key (the mirror setup above), a malicious push can run
  code that reads `~gate/.ssh/id_ed25519` and pushes to upstream directly, which
  defeats the gate. So: use only **filesystem** gates when the box also mirrors to
  upstream, or keep the upstream credential off the gate box. Filesystem-only gates
  don't execute pushed code and are safe to combine with the mirror.
- The version of skillgate the hook runs is pinned (`SKILLGATE_VERSION`, default in
  `pre-receive`/`provision.sh`) so a push can't pull a different package off npm
  than the box was provisioned with.
- The pinned `done.yaml` is updated by re-provisioning — a deliberate admin action,
  not something the agent can do.
