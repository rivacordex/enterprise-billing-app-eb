# um30-spec §"Container image". Multi-stage build — no .env/secrets/DB URLs
# baked into any layer; all runtime config is injected at Container Apps
# revision creation time from Key Vault references.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Full deps (incl. devDependencies) are required to run `next build`.
RUN npm ci
ARG BUILD_VERSION=local
ENV BUILD_VERSION=$BUILD_VERSION
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
COPY --from=builder --chown=nextjs:nodejs /app/lib/errors.ts ./lib/errors.ts
COPY --from=builder --chown=nextjs:nodejs /app/lib/logger.ts ./lib/logger.ts
COPY --from=builder --chown=nextjs:nodejs /app/types/password.ts ./types/password.ts
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENTRYPOINT ["node", "server.js"]
