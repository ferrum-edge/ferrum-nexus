# The deterministic HTTP upstream the end-to-end APIs are published against.
# No dependencies and no build: the whole service is one file, so the image is
# the base image plus a copy.
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app
COPY server.js ./
USER node
ENV PORT=9100
EXPOSE 9100
CMD ["node", "server.js"]
