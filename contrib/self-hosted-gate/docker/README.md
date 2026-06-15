# Gate as a Docker container

A lighter substrate than a full VM for the same idea: the gate runs in a container
your agent can't reach, so the definition of done is evaluated *outside* the agent.

A container is a weaker isolation boundary than a VM (shared kernel), but for this
threat model — an AI coding agent that wants to slip unfinished work past the gate,
not someone writing a kernel escape — it is enough, **as long as you close two
holes**:

1. **Deny the agent the Docker socket.** Access to `/var/run/docker.sock` (or the
   `docker` CLI) is root on the host: the agent could `exec` into this container,
   read the deploy key, or rewrite the hooks. The gate is only real if the agent
   can't run Docker.
2. **Keep the upstream push credential off the agent.** If the agent can push to
   GitHub directly, it bypasses the gate regardless of substrate.

The gate logic and the definition of done are baked into the image, never
bind-mounted read-write, so reaching this folder doesn't let the agent edit them.

## Quick start

```sh
cd contrib/self-hosted-gate/docker

# 1. the key you'll push with (its public half is authorised in the container)
ssh-keygen -t ed25519 -N "" -f ./push_key
cp ./push_key.pub ./authorized_key.pub

# 2. build + run (gate logic baked into the image)
docker compose up -d --build

# 3. point your repo at the gate and push
cd /path/to/your/repo
git remote add gate ssh://gate@127.0.0.1:2222/srv/repos/repo.git
GIT_SSH_COMMAND="ssh -i /path/to/contrib/self-hosted-gate/docker/push_key" \
  git push gate main        # rejected unless `skillgate check` passes
```

Without Compose:

```sh
cd contrib/self-hosted-gate
docker build -f docker/Dockerfile -t skillgate-gate .
docker run -d --name skillgate-gate -p 127.0.0.1:2222:22 \
  -v "$PWD/docker/authorized_key.pub:/run/authorized_key.pub:ro" \
  skillgate-gate
```

## Pin your own definition of done

By default the container initialises a stock skillgate spec. To enforce your own,
either uncomment the `./done.yaml:/run/done.yaml:ro` mount in `docker-compose.yml`,
or bake it into the image by adding to the `Dockerfile`:

```dockerfile
COPY done.yaml /opt/skillgate/.skillgate/done.yaml
```

Baking it in is the stronger option: there is no mounted file on the host for the
agent to edit.

## Optional: mirror gate-passed pushes to upstream

The container generates a deploy key on first start and prints its public half in
the logs (`docker compose logs gate`). Add it as a **write** deploy key on your
GitHub repo, set `SKILLGATE_UPSTREAM=git@github.com:you/repo.git` in the
`post-receive` environment, and drop the agent's own push access. Then the
container is the sole writer to upstream. Note the threat-model caveat in the
parent [`README.md`](../README.md): only use `command`-type gates here if the box
does **not** also hold that deploy key.

## Notes

- `command`-type gates (e.g. `npm test`) run the pushed tree's code in the
  container, so add your build deps to the `Dockerfile`. Filesystem gates
  (file-exists / contains / absent / evidence) need nothing.
- Tested end-to-end (clean push accepted, violating push rejected, `--no-verify`
  rejected) on Docker Engine with Compose v2+.
