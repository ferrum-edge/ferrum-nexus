# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Native build tools for better-sqlite3 when no prebuilt binary matches
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --ignore-scripts \
  && npm rebuild better-sqlite3 esbuild

COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY web/ web/
RUN npm run build --workspace shared \
  && npm run build --workspace server \
  && npm run build --workspace web

# Production dependencies only
RUN npm ci --omit=dev --ignore-scripts \
  && npm rebuild better-sqlite3

# ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/src/db/migrations server/src/db/migrations
COPY --from=build /app/web/dist web/dist

# SQLite data lives here by default; mount a volume to persist it
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME /app/data

ENV NEXUS_HOST=0.0.0.0 \
    NEXUS_PORT=8787 \
    NEXUS_SQLITE_PATH=/app/data/nexus.sqlite \
    NEXUS_WEB_DIST=/app/web/dist

EXPOSE 8787
CMD ["node", "server/dist/index.js"]
