# SPA image — static build served by nginx (ARCH §5: "Docker container
# (nginx/Caddy) behind tailscale serve; static files only, disposable tier").
#
# Build (repo root): docker compose build app
# The build arg bakes the seeded connection URL into the bundle (see
# app/src/lib/connections.ts + DEPLOY.md).
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
ARG VITE_DEFAULT_WS_URL=""
ENV VITE_DEFAULT_WS_URL=${VITE_DEFAULT_WS_URL}
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @haro/app build

FROM nginx:alpine
COPY app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/app/dist /usr/share/nginx/html
EXPOSE 80