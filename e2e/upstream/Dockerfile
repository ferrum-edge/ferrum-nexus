# The deterministic HTTP upstream the end-to-end APIs are published against.
# No dependencies and no build: the whole service is one file, so the image is
# the base image plus a copy.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
WORKDIR /app
COPY server.js ./
USER node
ENV PORT=9100
EXPOSE 9100
CMD ["node", "server.js"]
