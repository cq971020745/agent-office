FROM node:22-bookworm-slim
# doc_to_md 的旧版 Word / PPT / Excel 降级转换依赖本机 soffice，正文提取依赖 Python。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 libreoffice-writer libreoffice-calc libreoffice-impress \
 && rm -rf /var/lib/apt/lists/*
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
