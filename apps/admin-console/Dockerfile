FROM node:22-alpine AS builder
WORKDIR /app

# Plain npm install — no pnpm workspace needed since admin-console has no workspace deps.
COPY apps/admin-console/package.json ./package.json
RUN npm install
COPY apps/admin-console ./
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3001
CMD ["node", "server.js"]
