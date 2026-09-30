# The delinquency keeper, built from the repository root.
#
#   RAILWAY_DOCKERFILE_PATH=apps/keeper/Dockerfile
#
# Only the keeper and the workspace packages it imports are installed and
# built. KEEPER_PRIVATE_KEY and KEEPER_SHARED_SECRET arrive at run time and are
# never part of the image; without the key the server answers /tick with a dry
# run, and without the secret it refuses /tick outright.
FROM node:22-slim
# The slim image ships no CA bundle. Node carries its own, but native TLS
# clients verify against the system store and fail with UnknownIssuer without
# it, so the bundle is installed for any dependency that brings one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@tabai/keeper..." \
 && pnpm --filter "@tabai/keeper..." run build
ENV NODE_ENV=production
CMD ["node", "apps/keeper/dist/main.js", "serve"]
