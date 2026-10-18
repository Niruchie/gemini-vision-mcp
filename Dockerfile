# syntax=docker/dockerfile:1
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS build
RUN npm install -g pnpm@12
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:${NODE_VERSION}-slim AS runtime
RUN npm install -g pnpm@12
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
EXPOSE 3000
USER node
# HTTP transport by default (stdio is for local `command:` use).
# Override CMD for stdio: ["node", "dist/index.js"]
#
# SECURITY: this binds every interface, so MCP_AUTH_TOKEN is REQUIRED -
# the server refuses to start without it. Example:
#   docker run --rm -p 3000:3000 \
#     -e GOOGLE_API_KEY=... -e MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
#     gemini-vision-mcp:0.1.0
CMD ["node", "dist/index.js", "--transport", "http", "--host", "0.0.0.0", "--port", "3000"]
