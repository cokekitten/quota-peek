# syntax=docker/dockerfile:1.7

###############################################################################
# Stage 1 — install dependencies
# Pull the full lockfile-pinned node_modules so the build is reproducible.
#
# node:20-slim (glibc), not alpine: better-sqlite3 — the usage-history store —
# publishes prebuilt bindings for glibc only. On musl, `npm ci` would fall back
# to node-gyp and need a full python3/make/g++ toolchain in this stage.
# better-sqlite3 is pinned to 12.4.1 on purpose: that release still ships a
# Node 20 (ABI 115) prebuild. 12.11+/13.x declare `engines: node >=22` and would
# compile from source here, which needs a toolchain this stage doesn't have.
###############################################################################
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

###############################################################################
# Stage 2 — build the Next.js standalone bundle
###############################################################################
FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Next reads this to decide which telemetry events to send — turn it off.
ENV NEXT_TELEMETRY_DISABLED=1
# The .env here only affects the build, not runtime secrets; .dockerignore
# strips the real .env so nothing sensitive leaks into the image.
RUN npm run build

###############################################################################
# Stage 3 — minimal runtime image
# Only the standalone server, its traced deps, static assets, and public/.
###############################################################################
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Where the standalone server looks for static assets. See Next.js docs:
# https://nextjs.org/docs/app/api-reference/config/next-config-js/output
ENV PORT=5928
ENV HOSTNAME=0.0.0.0

# Where the usage-history database lives. Mount a volume here; the container
# runs as uid 1000 (`node`), so the host directory must be writable by it
# (mkdir -p data && chown 1000:1000 data) — see docker-compose.yml.
ENV QP_DATA_DIR=/app/data
RUN mkdir -p /app/data && chown node:node /app/data

# Run as the non-root `node` user that ships with the node image.
USER node

# Standalone server + its traced static assets.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

EXPOSE 5928

# The standalone server respects PORT + HOSTNAME env vars (set above).
CMD ["node", "server.js"]
