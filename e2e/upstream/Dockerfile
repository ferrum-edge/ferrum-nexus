# The deterministic HTTP upstream the end-to-end APIs are published against.
# No dependencies and no build: the whole service is one file, so the image is
# the base image plus a copy.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /app
COPY server.js ./
USER node
ENV PORT=9100
EXPOSE 9100
CMD ["node", "server.js"]
