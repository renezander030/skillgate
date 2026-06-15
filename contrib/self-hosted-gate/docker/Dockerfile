# Dockerfile — the skillgate gate as a container. The gate logic and the definition
# of done are BAKED INTO THE IMAGE (not bind-mounted), so even an agent that reaches
# this directory can't edit them: it has no shell into the container.
#
# Build context is the parent (self-hosted-gate/) so we can bake the shared hooks +
# installer:  docker build -f docker/Dockerfile -t skillgate-gate .
FROM alpine:3.19

RUN apk add --no-cache git openssh nodejs npm tar && ssh-keygen -A

# Immutable gate logic baked into the image (read-only at runtime).
WORKDIR /opt/skillgate-src
COPY pre-receive post-receive gate-install.sh ./

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /opt/skillgate-src/*

# Push over SSH, exactly like the VM/VPS variants.
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
