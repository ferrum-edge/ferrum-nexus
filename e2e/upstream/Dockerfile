# The deterministic HTTP upstream the end-to-end APIs are published against.
# No dependencies and no build: the whole service is one file, so the image is
# the base image plus a copy.
FROM node:22-bookworm-slim
WORKDIR /app
COPY server.js ./
USER node
ENV PORT=9100
EXPOSE 9100
CMD ["node", "server.js"]
