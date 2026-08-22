# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json ./
COPY package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    CTX_DATA_DIR=/data \
    CTX_TRANSPORT=stdio \
    # From inside a container, "localhost" is the container itself. The LLM
    # runs on the host, which Docker Desktop exposes under this name. On
    # Linux, run with --add-host=host.docker.internal:host-gateway.
    CTX_LLM_BASE_URL=http://host.docker.internal:1234/v1

WORKDIR /app
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY --from=build /build/package.json ./package.json

# The store must outlive the container, so /data is a volume. Without one,
# every restart silently loses all sessions and documents.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "if(process.env.CTX_TRANSPORT!=='http')process.exit(0); \
    fetch('http://127.0.0.1:'+(process.env.CTX_HTTP_PORT||3001)+'/health') \
    .then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--", "node", "dist/index.js"]
CMD ["--stdio"]
