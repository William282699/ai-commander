# AI Commander — single-service deploy.
# The Express server (apps/server) serves BOTH /api/* and the built SPA
# (apps/web/dist) on one port, so the frontend uses same-origin /api in prod.
#
# Build: npm ci (full install — vite/tsc/tsx are needed) + npm run build
#        (typecheck all workspaces + vite build -> apps/web/dist).
# Run:   the server (tsx) on $PORT, bound to 0.0.0.0.
#
# Works on Fly.io / Railway / Render (any Docker host).

FROM node:20-slim

WORKDIR /app

# Install deps + build the SPA. node_modules / dist / .env are excluded via
# .dockerignore, so npm ci installs cleanly and no secret is baked in.
COPY . .
RUN npm ci && npm run build

ENV NODE_ENV=production
# Host platforms usually inject PORT; default to 8080 to match fly.toml.
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "run", "start", "--workspace=apps/server"]
