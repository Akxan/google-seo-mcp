FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production MCP_TRANSPORT=http MCP_HOST=0.0.0.0 MCP_PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js", "--http"]
