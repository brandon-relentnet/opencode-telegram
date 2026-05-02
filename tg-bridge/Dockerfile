# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Native deps for better-sqlite3 build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN npm run build

# Strip dev deps for the runtime image
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# better-sqlite3's prebuilt binary needs libstdc++; bookworm-slim ships it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 bridge \
 && useradd  --system --uid 1001 --gid bridge --home /app --shell /sbin/nologin bridge \
 && mkdir -p /data \
 && chown -R bridge:bridge /app /data

COPY --from=builder --chown=bridge:bridge /app/node_modules ./node_modules
COPY --from=builder --chown=bridge:bridge /app/dist ./dist
COPY --from=builder --chown=bridge:bridge /app/package.json ./package.json

USER bridge
ENV NODE_ENV=production
ENV SQLITE_PATH=/data/chat-state.sqlite

CMD ["node", "dist/index.js"]
