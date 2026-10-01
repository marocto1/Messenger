FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/desktop/package.json apps/desktop/package.json
RUN npm ci --omit=dev --workspace server --include-workspace-root=false
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY server/package.json server/index.js server/security.js ./server/
RUN mkdir -p /app/server/data && chown -R node:node /app
USER node
VOLUME /app/server/data
EXPOSE 4000
CMD ["node","server/index.js"]
