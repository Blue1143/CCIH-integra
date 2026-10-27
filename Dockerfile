# CCIH Integra — imagens de produção (API e web), construídas a partir do código do repositório.
# Uso: veja deploy/docker-compose.yml e docs/implantacao/01-PUBLICACAO.md. Nenhum segredo entra na imagem:
# tudo vem por variável de ambiente no momento de subir os containers.

# ---------- Dependências (cache por package-lock) ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/demo-data/package.json packages/demo-data/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

# ---------- Build (API empacotada e web estática) ----------
FROM deps AS build
COPY . .
# A web exige a fonte de dados no build; "api" é o modo de produção (a demonstração no navegador é só leitura).
ARG VITE_DATA_SOURCE=api
ENV VITE_DATA_SOURCE=${VITE_DATA_SOURCE}
RUN npm run tokens:check && npm run build -w @ccih/api && npm run build -w @ccih/web

# ---------- API ----------
FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 UPLOAD_DIR=var/uploads
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/demo-data/package.json packages/demo-data/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Só as dependências de execução da API (os pacotes do monorepo já estão dentro do bundle).
RUN npm ci --omit=dev --no-audit --no-fund -w @ccih/api && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
RUN mkdir -p apps/api/var/uploads && chown -R node:node apps/api/var
USER node
WORKDIR /app/apps/api
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/server.js"]

# ---------- Web (arquivos estáticos + HTTPS automático + proxy da API) ----------
FROM caddy:2.10-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
