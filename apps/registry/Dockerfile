# The registry indexer and read API, built from the repository root.
#
#   RAILWAY_DOCKERFILE_PATH=apps/registry/Dockerfile
#
# Only the registry and the workspace packages it imports are installed and
# built. The schema is applied on every start; it is idempotent, so a restart
# against an existing database changes nothing.
FROM node:22-slim
# The slim image ships no CA bundle. Node carries its own, but native clients
# (HyperSync's among them) verify TLS against the system store and fail with
# UnknownIssuer without it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@tabai/registry..." \
 && pnpm --filter "@tabai/registry..." run build
ENV NODE_ENV=production
CMD ["sh", "-c", "pnpm --filter @tabai/registry db:apply && node apps/registry/dist/main.js"]
