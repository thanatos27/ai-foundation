# syntax=docker/dockerfile:1
# The REST API (src/serve-http.ts) for Cloud Run. No config or credential is baked in:
# AI_FOUNDATION_CONFIG and the credential variables are set at run time (docs/deploy/cloud-run.md).

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# Owned by root: the node user can read the app but not change it.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
# Exec form: node is PID 1 and receives SIGTERM itself. Cloud Run sets PORT.
CMD ["node", "dist/serve-http.js", "--no-env-file", "--host", "0.0.0.0"]
