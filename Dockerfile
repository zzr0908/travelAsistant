# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/travel
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN node scripts/bootstrap.mjs --skip-install
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/travel
COPY --from=build --chown=node:node /opt/travel/package.json ./
COPY --from=build --chown=node:node /opt/travel/node_modules ./node_modules
COPY --from=build --chown=node:node /opt/travel/dist ./dist
COPY --from=build --chown=node:node /opt/travel/runtime/harness-validator.cjs ./runtime/harness-validator.cjs
RUN mkdir -p /data /config && chown node:node /data /config
USER node
ENV HOST=0.0.0.0 INTERNAL_HOST=0.0.0.0 DATA_DIR=/data TRAVEL_CONFIG_DIR=/config
EXPOSE 4317
CMD ["node", "dist/server/service/server/main.js"]

FROM node:24-bookworm-slim AS agent
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/travel
COPY --from=build --chown=node:node /opt/travel/package.json ./
COPY --from=build --chown=node:node /opt/travel/node_modules ./node_modules
COPY --from=build --chown=node:node /opt/travel/dist/server ./dist/server
COPY --from=build --chown=node:node /opt/travel/config/harness ./config/harness
COPY --from=build --chown=node:node /opt/travel/runtime ./runtime
COPY --from=build --chown=node:node /opt/travel/vendor/deepseek-harness ./vendor/deepseek-harness
COPY --from=build --chown=node:node /opt/travel/scripts/start-agent.mjs ./scripts/start-agent.mjs
RUN mkdir -p /agent-data && chown node:node /agent-data
USER node
ENV AGENT_DATA_DIR=/agent-data BROWSER_CHROME_PATH=/usr/bin/chromium BROWSER_ENABLED=1 BROWSER_NO_SANDBOX=1
CMD ["node", "scripts/start-agent.mjs"]
