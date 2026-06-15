# Testing the self-hosted gate end-to-end

A portable sample that proves the gate works: it boots the Alpine gate VM, pushes a
clean repo (accepted) and a violating repo (rejected by the server-side hook). No
machine-specific paths — run it from this directory on any host with VirtualBox +
Vagrant.

## Prerequisites

- **VirtualBox** + **Vagrant** (both free; no Docker / WSL2 needed).
- `git`, `ssh`, `ssh-keygen` on PATH (Git Bash provides them on Windows).
- Network access (the VM downloads the Alpine box + the `skillgate` npm package).

## One-shot test script

Save as `test.sh` next to the `Vagrantfile`, then `sh test.sh`:

```sh
#!/usr/bin/env sh
# End-to-end test of the self-hosted skillgate gate. Run from contrib/self-hosted-gate.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"; cd "$here"

# 1. a throwaway push key + a sample definition of done (in THIS dir, where the
#    Vagrantfile copies them into the VM).
[ -f test_push_key ] || ssh-keygen -t ed25519 -N "" -C gate-test -f "$here/test_push_key" >/dev/null
cp -f "$here/test_push_key.pub" "$here/authorized_key.pub"
if [ ! -f "$here/done.yaml" ]; then
  npx -y "@reneza/skillgate@${SKILLGATE_VERSION:-0.1.0}" init >/dev/null 2>&1 || true
  [ -f "$here/.skillgate/done.yaml" ] && cp "$here/.skillgate/done.yaml" "$here/done.yaml"
fi

# 2. boot + provision the gate VM (vagrant up no-ops if it exists; provision forces
#    the gate install — needed if the VM already existed).
vagrant up
vagrant provision

# 3. a throwaway repo to push through the gate.
work="$(mktemp -d)"; repo="$work/sample"; git init -q "$repo"
( cd "$repo"
  git config user.email t@example.com; git config user.name tester
  printf '# sample\n' > README.md; git add README.md; git commit -qm init
  git remote add gate ssh://gate@127.0.0.1:2222/srv/repos/repo.git )

# never hang on a password prompt — key only.
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i $here/test_push_key"

echo "== ACCEPT (clean push) =="
( cd "$repo" && git push gate master ); echo "  accept exit=$? (expect 0)"

echo "== REJECT (violating push) =="
# default `skillgate init` forbids TODO/FIXME in src/**/*.{ts,js}
( cd "$repo"
  mkdir -p src; printf 'export const x = 1 // TODO: finish\n' > src/x.js
  git add src/x.js; git commit -qm "should be rejected"
  git push gate master ) && rc=0 || rc=$?
echo "  reject exit=${rc:-?} (expect non-zero)"

rm -rf "$work"
echo "Done. (Stop the VM with: vagrant halt   — or remove it: vagrant destroy -f)"
```

## What "passing" looks like

1. **Clean push → accepted** (`accept exit=0`).
2. **Violating push → rejected**: the gate output, then
   `! [remote rejected] master -> master (pre-receive hook declined)`, non-zero exit.
3. (Optional, the strongest check) re-run the violating push with
   `git push --no-verify` — **still rejected**, proving a server-side hook can't be
   skipped from the client.

## Notes

- `test_push_key*`, `authorized_key.pub`, `done.yaml`, `.skillgate/`, and `.vagrant/`
  are local test artifacts — they're git-ignored (see `.gitignore`).
- For the **hard** guarantee (the agent can't bypass the gate), also move the
  upstream push credential into the VM and drop the host's direct push access — see
  [`README.md`](README.md).
