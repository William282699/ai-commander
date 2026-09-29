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

# 试玩记录仪 V1：把构建的提交号带进镜像（导出包 manifest.build）。镜像里没有 .git、也没有 git 二进制，
# 只能靠部署流程用 --build-arg 传进来（.github/workflows/fly-deploy.yml）；没传就是 unknown。
# 放在构建步骤之后，改它不会让 npm ci 那一层失效。
ARG RECORDER_BUILD=unknown
ENV RECORDER_BUILD=$RECORDER_BUILD

# 直接起 node，不经 npm。npm 收到停机信号约 3 ms 就自己退出（SIGTERM 退出码 1；当 PID 1 时 SIGINT 干脆不理），
# 容器随之被收，服务端来不及把最后几条记录落盘（试玩记录仪 T15，Colima 真容器实测 2026-09-28：
# 旧起法两种信号都不过；这样起 ~130 ms 内排空、退出码 0）。tsx 已由 npm ci 提升到根 node_modules；
# .env 与前端 dist 的路径都按源码文件位置解析，与工作目录无关。
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
