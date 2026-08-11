# Builds web/ and bakes the bundle into Caddy, so the deployed artifact is a
# pullable image rather than a directory the host has to be handed out-of-band.
FROM oven/bun:1.3.14-alpine AS build

WORKDIR /app

COPY web/package.json web/bun.lock ./

RUN bun install --frozen-lockfile

COPY web/ ./

# Vite inlines these into the bundle at build time — supplying them at runtime
# would be far too late to reach the client.
ARG VITE_GNOSIS_RPC=""
ARG VITE_WALLETCONNECT_PROJECT_ID=""
ENV VITE_GNOSIS_RPC=$VITE_GNOSIS_RPC
ENV VITE_WALLETCONNECT_PROJECT_ID=$VITE_WALLETCONNECT_PROJECT_ID

RUN bun run build

FROM caddy:2.8-alpine

COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 80

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
