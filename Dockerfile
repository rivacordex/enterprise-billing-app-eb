# um30-spec §"Container image". Multi-stage build — no .env/secrets/DB URLs
# baked into any layer; all runtime config is injected at Container Apps
# revision creation time from Key Vault references.
#
# bm18-spec §Implementation §1 — every stage moved from `node:22-alpine` to
# `node:22-bookworm-slim` (Debian) for this unit. Playwright's Chromium build
# needs glibc plus `apt`-installable OS dependencies (fonts, X11 libs, etc.);
# Alpine's musl libc and `apk` are not a supported target for
# `npx playwright install --with-deps` (see
# infra/docs/rendering-image-size.md for the full rationale, the resulting
# image-size increase, and the alternatives considered). `deps`/`builder` move
# to the same base as `runner` so the one node_modules tree built in `deps`
# (with its platform-specific optionalDependencies binaries) stays
# glibc-consistent everywhere it's copied — mixing libc families across the
# `COPY --from=deps` step would silently break any native addon.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the prod tree drags in drizzle-kit (an optional peer of
# better-auth) → the deprecated @esbuild-kit → esbuild 0.18.20, whose
# postinstall self-check collides with the hoisted newer esbuild under
# --omit=dev. None of the runtime deps (tsx/esbuild, postgres, drizzle-orm)
# need lifecycle scripts — their native binaries ship as prebuilt platform
# packages via optionalDependencies — so skipping scripts is safe here.
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS builder
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
# Fail the build if eval( appears in any shipped JS chunk (ZAP PR13v2 fix 2.4,
# rule 10110). eval() at runtime would also throw due to script-src 'self'
# (no 'unsafe-eval'), but catching it here prevents a CSP violation on users.
# grep exit codes: 0 = match found (fail), 1 = no match (pass), >1 = grep
# itself errored (e.g. .next/static missing/unreadable) — must also fail,
# not be swallowed by a bare `! grep`.
RUN grep -rl "eval(" .next/static; rc=$?; \
  if [ "$rc" -eq 0 ]; then echo "eval( found in shipped JS chunks" >&2; exit 1; fi; \
  if [ "$rc" -ne 1 ]; then echo "grep failed inspecting .next/static (exit $rc)" >&2; exit "$rc"; fi

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ARG BUILD_VERSION=local
ENV BUILD_VERSION=$BUILD_VERSION

# Debian's `useradd`/`groupadd` (from the base `login`/`passwd` packages,
# present in every official Debian image) — the direct equivalent of Alpine's
# `adduser`/`addgroup --system` used before this unit's base-image switch.
RUN groupadd --system nodejs && \
    useradd --system --gid nodejs --no-create-home nextjs

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

# bm18-spec §Implementation §1 — Chromium + its OS deps for Playwright, baked
# into the runtime image (D16/D17): this is the platform's first in-app
# document rendering, so Chromium is now a runtime dependency, not just a
# CI/test one. `playwright` is pinned exactly in package.json/package-lock.json
# so the installed browser build is reproducible across builds. Runs as root
# (before `USER nextjs` below) since `--with-deps` needs `apt-get install`;
# PLAYWRIGHT_BROWSERS_PATH pins a fixed, known install location so the
# ownership handoff to the non-root runtime user is a single explicit chown,
# rather than depending on wherever Playwright's default (root's home
# directory) happens to resolve.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium && \
    chown -R nextjs:nodejs /ms-playwright

USER nextjs
EXPOSE 3000
ENV PORT=3000
# Bind standalone server.js to all interfaces. Without this, a platform-injected
# HOSTNAME (e.g. the container name) would make it bind to an unreachable host,
# failing the Container Apps liveness/readiness probes against /api/health.
ENV HOSTNAME=0.0.0.0
ENTRYPOINT ["node", "server.js"]
