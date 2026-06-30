# um30-spec §"Container image". Multi-stage build — no .env/secrets/DB URLs
# baked into any layer; all runtime config is injected at Container Apps
# revision creation time from Key Vault references.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the prod tree drags in drizzle-kit (an optional peer of
# better-auth) → the deprecated @esbuild-kit → esbuild 0.18.20, whose
# postinstall self-check collides with the hoisted newer esbuild under
# --omit=dev. None of the runtime deps (tsx/esbuild, postgres, drizzle-orm)
# need lifecycle scripts — their native binaries ship as prebuilt platform
# packages via optionalDependencies — so skipping scripts is safe here.
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-alpine AS builder
WORKDIR /app
# Install full deps (incl. devDependencies, required to run `next build`)
# before copying the source so the npm layer caches on lockfile changes only.
# No COPY of the deps stage's node_modules — npm ci recreates it anyway.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG BUILD_VERSION=local
ENV BUILD_VERSION=$BUILD_VERSION
# Build-time-only placeholders. lib/config.ts validates these env vars at
# import time, and `next build` evaluates server modules (e.g. the auth route
# handlers) that import it — without them the build throws "Invalid environment
# configuration". They are confined to this `builder` stage; the `runner` stage
# below inherits none of them, and Container Apps injects the real values from
# Key Vault at runtime. No real secret is ever baked into any image layer.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV BETTER_AUTH_SECRET=build_time_placeholder_secret_min_32_chars
ENV BETTER_AUTH_URL=http://localhost:3000
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ARG BUILD_VERSION=local
ENV BUILD_VERSION=$BUILD_VERSION

RUN addgroup --system nodejs && adduser --system --ingroup nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Overlay the full production node_modules (incl. tsx, drizzle-orm,
# postgres) over standalone's traced/pruned subset, plus the migration
# script + SQL files — the migrate Container Apps Job (um30-spec) reuses
# this exact image/tag, running `node --import tsx db/migrate.ts` instead
# of standalone's `server.js`.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/db/migrate.ts ./db/migrate.ts
COPY --from=builder --chown=nextjs:nodejs /app/db/migrations ./db/migrations
COPY --from=builder --chown=nextjs:nodejs /app/lib/config.ts ./lib/config.ts
# lib/config.ts imports lib/locale.ts (um29: DEFAULT_TIMEZONE/SUPPORTED_TIMEZONES).
# Without it the migrate Job's `node --import tsx db/migrate.ts` fails at import
# with MODULE_NOT_FOUND '@/lib/locale'.
COPY --from=builder --chown=nextjs:nodejs /app/lib/locale.ts ./lib/locale.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/errors.ts ./lib/errors.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/logger.ts ./lib/logger.ts
COPY --from=builder --chown=nextjs:nodejs /app/types/password.ts ./types/password.ts
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json

USER nextjs
EXPOSE 3000
ENV PORT=3000
# Bind standalone server.js to all interfaces. Without this, a platform-injected
# HOSTNAME (e.g. the container name) would make it bind to an unreachable host,
# failing the Container Apps liveness/readiness probes against /api/health.
ENV HOSTNAME=0.0.0.0
ENTRYPOINT ["node", "server.js"]
