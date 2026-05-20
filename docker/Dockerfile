# syntax=docker/dockerfile:1.7
# Multi-stage build for Ferrum Nexus. Produces a single image that serves both
# the SPA (from web/dist) and the BFF (server/dist).

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
 && npm ci --include=dev \
 && rm -rf /var/lib/apt/lists/*

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXUS_HOST=0.0.0.0 \
    NEXUS_PORT=8787
COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && npm ci --omit=dev \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY --from=build /app/server/src/db/migrations server/dist/db/migrations
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.NEXUS_PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","server/dist/index.js"]
