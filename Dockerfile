# syntax=docker/dockerfile:1

# Multi-stage build for Next.js (Bun)

FROM oven/bun:1.3.5-debian AS deps
WORKDIR /app

# System deps needed for some native modules during install (kept in build stage)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.5-debian AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

COPY . .

# Ensure Next builds in production mode
ENV NODE_ENV=production
RUN bun run build


FROM oven/bun:1.3.5-debian AS runner
WORKDIR /app

RUN set -euxo pipefail; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates bash xvfb xauth fonts-liberation libasound2 libnss3 libxss1 libgtk-3-0; \
  if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
    apt-get install -y --no-install-recommends wget gnupg; \
    wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-linux-signing-keyring.gpg; \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-signing-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends google-chrome-stable; \
  else \
    apt-get install -y --no-install-recommends chromium; \
  fi; \
  rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV DOCKER=true

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

CMD ["sh", "-lc", "xvfb-run -a --server-args='-screen 0 1280x1024x24 -nolisten tcp' bun /app/src/lib/server_start.ts"]
