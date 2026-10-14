FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --filter @office/server --filter @office/shared
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @office/shared build && pnpm --filter @office/server build
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
EXPOSE 8787
CMD ["node", "apps/server/dist/index.js"]
