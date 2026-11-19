# Builds the Stock-out Watch web app (modules/stock-watch). Railway uses this file.
FROM node:22-alpine
# tini as PID 1: passes SIGTERM to node (graceful save on redeploy) and reaps zombies
RUN apk add --no-cache tini
WORKDIR /app
COPY modules/stock-watch/package.json ./
COPY modules/stock-watch/server.js ./
COPY modules/stock-watch/src ./src
COPY modules/stock-watch/public ./public
ENV NODE_ENV=production PORT=4400 DATA_DIR=/data
# No VOLUME line: Railway rejects it. Attach a Railway volume at /data instead.
RUN mkdir -p /data && chown node:node /data
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
