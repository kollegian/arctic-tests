# syntax=docker/dockerfile:1.7
ARG SEID_CLI_IMAGE=ghcr.io/sei-protocol/sei:v6.4.3

FROM ${SEID_CLI_IMAGE} AS seid-cli

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
COPY --from=seid-cli /usr/bin/seid /usr/local/bin/seid
COPY --from=seid-cli /usr/lib/libwasmvm*.so /usr/lib/
# `seid keys add` defaults to keyring backend `os` which prompts for a
# password — non-TTY containers hang. Pin to file-based test backend.
ENV SEID_KEYRING_BACKEND=test
USER 10001:10001
# tsx runs the wrapper directly; bypasses npm/yarn PID-1 signal-forwarding subtleties.
ENTRYPOINT ["node", "node_modules/.bin/tsx", "bin/release-test.ts"]
