# Gate on a remote VPS

The cleanest substrate: a genuinely separate machine your agent has no login to.
Your agent runs on your laptop and pushes over SSH; the gate logic, the definition
of done, and the upstream deploy key all live on the VPS. This is exactly what a CI
server is, on a box you own, for the price of the smallest instance. A container on
the VPS is optional (dependency isolation / easy teardown) and adds nothing to the
security boundary — the separate machine *is* the boundary.

## Prerequisites

- A fresh VPS you can reach as `root` over SSH (any small Debian/Ubuntu, Fedora,
  or Alpine instance works; the installer detects apt/dnf/yum/apk).
- `git`, `ssh`, `scp`, `ssh-keygen` on your machine.

## Quick start

```sh
cd contrib/self-hosted-gate

# the key you'll push with
ssh-keygen -t ed25519 -N "" -f ./push_key
cp ./push_key.pub ./authorized_key.pub        # vps/setup.sh authorises this

# install the gate on the VPS
sh vps/setup.sh root@vps.example.com

# point your repo at it
cd /path/to/your/repo
git remote add gate ssh://gate@vps.example.com:22/srv/repos/repo.git
GIT_SSH_COMMAND="ssh -i /path/to/contrib/self-hosted-gate/push_key" \
  git push gate main        # rejected unless `skillgate check` passes
```

To pin your own definition of done, drop a `done.yaml` in
`contrib/self-hosted-gate/` before running `setup.sh` (it is copied to the VPS).
Otherwise a default skillgate spec is initialised on the box.

## Make it the *only* path to upstream

The boundary is only complete when the agent can't bypass the VPS by pushing to
GitHub directly:

1. `setup.sh` prints a deploy key generated on the VPS. Add it as a **write**
   deploy key on your GitHub repo.
2. Set `SKILLGATE_UPSTREAM=git@github.com:you/repo.git` in the gate user's
   `post-receive` environment on the VPS.
3. Remove your agent's own GitHub push credential. Now every change reaches
   GitHub only after the VPS has gated it.

## Honest status

`setup.sh` is shell-linted and its package-manager detection covers apt / dnf /
yum / apk; the gate core (`../gate-install.sh`) is the same code tested end-to-end
under the Docker variant. The one VPS-specific step that varies by image is whether
`root` SSH is enabled out of the box — if your provider ships key-only or non-root
SSH, adjust the target user accordingly.
