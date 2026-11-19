FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=4400 DATA_DIR=/data
# No VOLUME line: Railway rejects it. Attach a Railway volume at /data instead.
RUN mkdir -p /data && chown node:node /data
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
USER node
CMD ["node", "server.js"]
