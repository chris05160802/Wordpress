FROM node:22-alpine

WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8686 \
    WPBM_DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8686
USER node
CMD ["node", "server.js"]
