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

FROM node:24-bookworm-slim AS runtime
ARG LLMINGRESS_VERSION=dev
WORKDIR /app
ENV NODE_ENV=production
ENV LLMINGRESS_VERSION=${LLMINGRESS_VERSION}
LABEL org.opencontainers.image.source="https://github.com/IamNotShady/LLMIngress"
LABEL org.opencontainers.image.version="${LLMINGRESS_VERSION}"
RUN groupadd --system --gid 1001 llmingress && useradd --system --uid 1001 --gid llmingress llmingress
COPY --from=build --chown=llmingress:llmingress /out/gateway/main.mjs ./gateway/main.mjs
COPY --from=build --chown=llmingress:llmingress /out/worker/main.mjs ./worker/main.mjs
COPY --from=build --chown=llmingress:llmingress /out/migrate/main.mjs ./migrate/main.mjs
COPY --from=build --chown=llmingress:llmingress /out/console/ ./console/
COPY --from=build --chown=llmingress:llmingress /src/packages/db/migrations ./packages/db/migrations
COPY --chmod=755 scripts/docker/docker-entrypoint.sh ./docker-entrypoint.sh
USER llmingress
EXPOSE 3000 4000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["gateway"]
