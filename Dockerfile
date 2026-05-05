# syntax=docker/dockerfile:1.7
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generates artifacts/ + typechain-types/ that tests import.
RUN npx hardhat compile

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd -r app && useradd -r -g app -u 10001 -d /home/app app && \
    mkdir -p /app/release-test-report /home/app && \
    chown -R app:app /app /home/app
ENV HOME=/home/app
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app . .
COPY --chown=app:app --from=build /app/artifacts ./artifacts
COPY --chown=app:app --from=build /app/typechain-types ./typechain-types
USER 10001:10001
# tsx runs the wrapper directly; bypasses npm/yarn PID-1 signal-forwarding subtleties.
ENTRYPOINT ["node", "node_modules/.bin/tsx", "bin/release-test.ts"]
