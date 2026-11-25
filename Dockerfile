# Shelfmark needs nothing but Node itself: no npm install, no build step.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    DOWNLOAD_DIR=/downloads

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

# The database, the uploaded list and the IRC settings live in /data. Mount a
# volume there. Files received over IRC go to /downloads: mount the folder you
# want them in at that path, or they are lost when the container is replaced.
RUN mkdir -p /data /downloads && chown node:node /data /downloads
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
