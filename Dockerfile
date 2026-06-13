# syntax=docker/dockerfile:1.7

###############################################################################
# Stage 1 — install dependencies
# Pulls the full lockfile-pinned node_modules so the build is reproducible.
###############################################################################
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

###############################################################################
# Stage 2 — build the Next.js standalone bundle
###############################################################################
FROM node:20-alpine AS builder
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
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Where the standalone server looks for static assets. See Next.js docs:
# https://nextjs.org/docs/app/api-reference/config/next-config-js/output
ENV PORT=5928
ENV HOSTNAME=0.0.0.0

# Run as the non-root `node` user that ships with the node image.
USER node

# Standalone server + its traced static assets.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

EXPOSE 5928

# The standalone server respects PORT + HOSTNAME env vars (set above).
CMD ["node", "server.js"]
