FROM node:24-bookworm-slim AS build

WORKDIR /src
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm exec esbuild apps/gateway/src/main.ts --bundle --platform=node --format=esm --target=node24 --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" --outfile=/out/gateway/main.mjs
RUN pnpm exec esbuild apps/worker/src/main.ts --bundle --platform=node --format=esm --target=node24 --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" --outfile=/out/worker/main.mjs
RUN pnpm exec esbuild scripts/migrate.ts --bundle --platform=node --format=esm --target=node24 --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" --outfile=/out/migrate/main.mjs
RUN pnpm --filter @llmingress/console build
RUN mkdir -p /out/console/apps/console/.next \
  && cp -R apps/console/.next/standalone/. /out/console/ \
  && cp -R apps/console/.next/static /out/console/apps/console/.next/static \
  && cp -R apps/console/public /out/console/apps/console/public

FROM node:24-bookworm-slim AS gateway
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 llmingress && useradd --system --uid 1001 --gid llmingress llmingress
COPY --from=build --chown=llmingress:llmingress /out/gateway/main.mjs ./main.mjs
USER llmingress
EXPOSE 4000
CMD ["node", "/app/main.mjs"]

FROM node:24-bookworm-slim AS worker
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 llmingress && useradd --system --uid 1001 --gid llmingress llmingress
COPY --from=build --chown=llmingress:llmingress /out/worker/main.mjs ./main.mjs
USER llmingress
CMD ["node", "/app/main.mjs"]

FROM node:24-bookworm-slim AS migrate
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 llmingress && useradd --system --uid 1001 --gid llmingress llmingress
COPY --from=build --chown=llmingress:llmingress /out/migrate/main.mjs ./main.mjs
COPY --from=build --chown=llmingress:llmingress /src/packages/db/migrations ./packages/db/migrations
USER llmingress
CMD ["node", "/app/main.mjs"]

FROM node:24-bookworm-slim AS console
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
RUN groupadd --system --gid 1001 llmingress && useradd --system --uid 1001 --gid llmingress llmingress
COPY --from=build --chown=llmingress:llmingress /out/console/ ./
USER llmingress
EXPOSE 3000
CMD ["node", "/app/apps/console/server.js"]
