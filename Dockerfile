# syntax=docker/dockerfile:1

# Multi-stage build for Next.js (Bun)

FROM oven/bun:1.4.2-debian AS deps
WORKDIR /app

# System deps needed for some native modules during install (kept in build stage)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4.2-debian AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

COPY . .

# Ensure Next builds in production mode
ENV NODE_ENV=production
RUN bun run build


FROM oven/bun:1.4.2-debian AS runner
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

RUN mkdir -p /app/data

COPY --from=builder /app/package.json ./
COPY --from=builder /app/bun.lock ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/next-env.d.ts ./
COPY --from=builder /app/next.config.ts ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/src ./src

EXPOSE 3000

CMD ["bun", "/app/src/lib/server_start.ts"]
