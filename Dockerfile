# Builds the Stock-out Watch web app (modules/stock-watch). Railway uses this file.
# Base image pinned by digest (SW-053): node 22.23.5 on Alpine, multi-arch index digest from Docker Hub (tag 22.23.5-alpine,
# 12 Nov 2026). To update: look up the new tag's digest (docs/RUNBOOK.md "Update the base image") and change both together.
FROM node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
# tini as PID 1: passes SIGTERM to node (graceful save on redeploy) and reaps zombies; su-exec drops root to `node`
RUN apk add --no-cache tini su-exec
WORKDIR /app
# BUILD_SHA (optional, written by `npm run stamp` before `railway up`): the commit /status and the footer show (SW-056).
# The glob lets the build pass without it; package.json always matches, so the COPY never has zero sources.
COPY modules/stock-watch/package.json modules/stock-watch/BUILD_SHA* ./
COPY modules/stock-watch/server.js ./
COPY modules/stock-watch/src ./src
COPY modules/stock-watch/public ./public
COPY modules/stock-watch/scripts/entrypoint.sh ./entrypoint.sh
ENV NODE_ENV=production PORT=4400 DATA_DIR=/data
# No VOLUME line: Railway rejects it. Attach a Railway volume at /data instead.
RUN chmod 755 /app/entrypoint.sh && mkdir -p /data && chown node:node /data
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
# No USER line: the entrypoint starts as root only to hand a root-owned volume to `node` (once), then runs the app as
# `node` (su-exec). Started as another user (docker run --user node), it just runs the app.
ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
CMD ["node", "server.js"]
