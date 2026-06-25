FROM node:22-alpine AS base
# pnpm for dependency installation; tsc installed globally so the build
# command runs against a real directory (not pnpm's virtual-store symlinks,
# which Node.js v22 cannot resolve as main-module entry points on Alpine).
RUN npm install -g pnpm@9 typescript@5.9.3

# ── Install all workspace deps ────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY .npmrc package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/admin-console/package.json ./apps/admin-console/
COPY packages/hash-ring/package.json ./packages/hash-ring/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/shared-types/package.json ./packages/shared-types/
RUN pnpm install --frozen-lockfile

# ── Build packages + worker ───────────────────────────────────────────────
COPY tsconfig.base.json ./
COPY packages/shared-types ./packages/shared-types
COPY packages/hash-ring ./packages/hash-ring
COPY apps/worker ./apps/worker
RUN tsc --project packages/shared-types/tsconfig.json
RUN tsc --project packages/hash-ring/tsconfig.json
RUN tsc --project apps/worker/tsconfig.json

# ── Runtime image ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/worker/dist ./dist
COPY --from=builder /app/packages/shared-types/package.json ./packages/shared-types/package.json
COPY --from=builder /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder /app/packages/hash-ring/package.json ./packages/hash-ring/package.json
COPY --from=builder /app/packages/hash-ring/dist ./packages/hash-ring/dist
CMD ["node", "dist/main.js"]
