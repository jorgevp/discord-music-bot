# syntax=docker/dockerfile:1

# ---------- dependencies (native modules are compiled here if no prebuilt binary exists)
FROM node:24-trixie-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- runtime
FROM node:24-trixie-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    XDG_CACHE_HOME=/data/cache \
    WEB_PORT=8080 \
    YTDLP_PIP=/opt/yt-dlp/bin/pip \
    YTDLP_PYTHON=/opt/yt-dlp/bin/python \
    PATH="/opt/yt-dlp/bin:${PATH}"

# ffmpeg decodes audio; yt-dlp (in a venv the app can update at runtime) fetches it. The yt-dlp[default]
# extra includes yt-dlp-ejs, which solves YouTube's JavaScript challenges using this image's Node runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir --disable-pip-version-check -U "yt-dlp[default]" bgutil-ytdlp-pot-provider \
 && mkdir -p /data /login-profile \
 && chown -R node:node /data /login-profile /opt/yt-dlp

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
