# Build the bundled artifact first with the repository-pinned pnpm 10.33.4:
# pnpm install --frozen-lockfile && pnpm backend:node:build && pnpm --filter @vwapp/backend auth:admin:build
# The image contains only the resulting Node bundle, never the workspace or .env.
FROM node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS base
ENV NODE_ENV=production \
    NODE_HOST=0.0.0.0 \
    NODE_PORT=8788 \
    BUZZKEY_SQLITE_PATH=/data/buzzkey.sqlite
WORKDIR /app
COPY --chown=node:node dist/node/main.mjs /app/main.mjs
COPY --chown=node:node dist/node/auth-admin.mjs /app/auth-admin.mjs
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8788/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
FROM base AS production
CMD ["node", "/app/main.mjs"]
