# ── Build stage: install deps (compiles sqlite3 native bindings) ──────────────
FROM node:22-alpine AS build

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Copy compiled node_modules and application files
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server.js    ./
COPY public/      ./public/

# /data is the mount point for the persistent SQLite database
VOLUME ["/data"]

EXPOSE 3000

ENV NODE_ENV=production \
    DB_PATH=/data/notifications.db

CMD ["node", "server.js"]
