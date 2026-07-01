FROM node:24-bookworm-slim AS base

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000 4000
CMD ["pnpm", "--filter", "@llmingress/gateway", "exec", "tsx", "src/main.ts"]
