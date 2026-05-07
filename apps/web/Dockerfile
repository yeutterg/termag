FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/package.json
COPY apps/agent/package.json apps/agent/package.json
RUN npm install

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# npm workspaces hoist everything to the root node_modules — apps/web/node_modules
# usually doesn't exist in the deps stage, so don't try to copy it.
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build -w apps/web

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/prisma ./apps/web/prisma
COPY --from=builder /app/apps/web/server.js ./apps/web/server.js
COPY --from=builder /app/apps/web/server ./apps/web/server
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
