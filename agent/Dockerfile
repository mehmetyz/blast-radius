# ---- build stage: compile TypeScript, audit dependencies ----
# Pinned by digest to node 22.23.2-slim (Debian bookworm) — the latest patched
# 22.x release at build time. Bump the digest to update the base deliberately.
FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
RUN npm audit --omit=dev --audit-level=high
COPY tsconfig.json ./
COPY src ./src
RUN npm run compile && cp src/schema.sql dist/schema.sql

# ---- runtime stage: minimal, non-root, no secrets ----
FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_PATH=/data/blast-radius.db
WORKDIR /app
RUN groupadd -r appuser && useradd -r -g appuser appuser \
  && mkdir -p /data && chown -R appuser:appuser /data
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER appuser
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
