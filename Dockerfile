# Builds the Stock-out Watch web app (modules/stock-watch). Railway uses this file.
FROM node:22-alpine
# tini as PID 1: passes SIGTERM to node (graceful save on redeploy) and reaps zombies
RUN apk add --no-cache tini
WORKDIR /app
# BUILD_SHA (optional, written by `npm run stamp` before `railway up`): the commit /status and the footer show (SW-056).
# The glob lets the build pass without it; package.json always matches, so the COPY never has zero sources.
COPY modules/stock-watch/package.json modules/stock-watch/BUILD_SHA* ./
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
