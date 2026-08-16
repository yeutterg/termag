FROM node:26-bookworm-slim AS deps
WORKDIR /app
# Prisma's native engine links libssl + libcrypto. bookworm-slim ships those
# but ca-certificates + openssl tooling are needed for engine init at build
# time and for HTTPS during npm install on first build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci

FROM node:26-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Prisma runs during `next build`, so the builder stage must be able to
# detect/load the same OpenSSL 3 engine target as the runtime stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# npm workspaces hoist everything to the root node_modules — apps/web/node_modules
# usually doesn't exist in the deps stage, so don't try to copy it.
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build -w apps/web

FROM builder AS production-deps
WORKDIR /app
RUN npm prune --omit=dev --ignore-scripts \
  && npm cache clean --force

FROM node:26-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS="--max-old-space-size=192 --max-semi-space-size=2"
ENV TERMINALZ_BIND_HOST=0.0.0.0
# Same packages as the deps stage — Prisma's runtime engine needs libssl3,
# and prisma migrate deploy + HTTPS callouts need openssl + CA bundle.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data \
  && chown node:node /data
COPY --from=builder /app/package.json ./package.json
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/prisma ./apps/web/prisma
COPY --from=builder /app/apps/web/server.js ./apps/web/server.js
COPY --from=builder /app/apps/web/server ./apps/web/server
RUN rm -rf ./apps/web/.next/cache \
  && chown -R node:node /app/apps/web
USER node
WORKDIR /app/apps/web
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(r.status>=500)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["sh", "-c", "../../node_modules/.bin/prisma migrate deploy && node server.js"]
