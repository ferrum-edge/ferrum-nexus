# Same qualified Node base as the existing deterministic acceptance upstream.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
WORKDIR /fixture
COPY controlled.mjs probe.mjs ./
CMD ["node", "controlled.mjs"]
