# =============================================================================
# EDIMS — Dockerfile
# Debian-based (not Alpine) because `sharp` ships native binaries that need
# glibc; Alpine's musl libc requires extra platform flags to get right.
# =============================================================================

FROM node:20-bookworm-slim AS base
WORKDIR /app

# Install only production dependencies, using the committed lockfile for
# reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Drop root — run as the pre-existing unprivileged 'node' user.
RUN mkdir -p logs public/images/hardware && chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
