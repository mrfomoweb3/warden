# Whole Warden stack in one container: x402 paid APIs, Warden, demo agents, dashboard
# (scripts/start-all.mjs supervises them). Secrets come from the host's env, never the image.
FROM node:24-slim
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY scripts ./scripts
# Dev dependencies are needed at runtime: services run TypeScript directly with tsx.
RUN pnpm install --frozen-lockfile

ENV PORT=8080
EXPOSE 8080
CMD ["node", "scripts/start-all.mjs"]
