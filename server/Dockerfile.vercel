FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js security.js db.js db-postgres-worker.js ./

RUN mkdir -p /app/data \
  && chown -R node:node /app

USER node
ENV DATA_DIR=/app/data
EXPOSE 4000
CMD ["node", "index.js"]
