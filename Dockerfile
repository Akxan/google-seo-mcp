FROM node:26-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev

FROM node:26-alpine
# openssh-client: WordPress tools run WP-CLI over SSH. git/ca-certificates: GitHub + HTTPS.
RUN apk add --no-cache openssh-client git ca-certificates
WORKDIR /app
ENV NODE_ENV=production MCP_TRANSPORT=http MCP_HOST=0.0.0.0 MCP_PORT=8080 HOME=/home/node
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY test/tools.snap.json ./test/tools.snap.json
COPY package.json ./
RUN mkdir -p /home/node/.ssh /data && chown -R node:node /home/node /app /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "dist/index.js", "--http"]
