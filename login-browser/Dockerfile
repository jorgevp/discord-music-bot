# syntax=docker/dockerfile:1
# Chromium on a virtual display, viewable through noVNC. Used once to sign the bot in to YouTube.
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium xvfb x11vnc novnc python3-websockify python3 \
      fonts-liberation fonts-dejavu-core ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home browser \
 && mkdir -p /profile \
 && chown browser:browser /profile

COPY server.py /app/server.py

USER browser
VOLUME ["/profile"]
EXPOSE 6080 6081
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:6081/health', timeout=3)"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python3", "/app/server.py"]
