# The metering gateway, built from the repository root.
#
#   RAILWAY_DOCKERFILE_PATH=apps/gateway/Dockerfile
#
# Only the gateway and the workspace packages it imports are installed and
# built. The operator key arrives as GATEWAY_PRIVATE_KEY at run time and is
# never part of the image.
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
RUN pnpm install --frozen-lockfile --filter "@tabai/gateway..." \
 && pnpm --filter "@tabai/gateway..." run build
ENV NODE_ENV=production
CMD ["node", "apps/gateway/dist/main.js"]
