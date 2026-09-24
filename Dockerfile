FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS builder
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine
# ssh: /claude talks to Claude Code on the host (see src/claude.ts).
RUN apk add --no-cache openssh-client
WORKDIR /app
ENV NODE_ENV=production
# Runs as root on purpose: it needs the host's Docker socket, whose group id
# differs between machines.
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
