# A Linux ModuleServer image: stock Slicer (Linux nightly or a pinned release) headless under Xvfb + Mesa,
# driven by ModuleServer/python/bootstrap.py. Rung 2 of the sandbox ladder when run with
#   docker run --read-only --tmpfs /tmp --network <proxy-only> -v <session>:/session -p 2131-2133:2131-2133 ...
# Needs a REAL container runtime (runc/containerd). Under gVisor (Modal, some Cloud Run configs) Slicer's
# main window deadlocks in Qt's thread pool -- see docs/MODULESERVER.md, S13.
#
#   docker build -t slicerlive/moduleserver -f ModuleServer/packaging/Dockerfile .
#   docker run --rm -p 2131:2131 -p 2132:2132 -p 2133:2133 -e MODULESERVER_TOKEN=secret slicerlive/moduleserver
#
FROM debian:bookworm-slim
ARG SLICER_URL="https://download.slicer.org/download?os=linux&stability=nightly"
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xvfb xauth fonts-dejavu-core fontconfig \
    libglu1-mesa libgl1 libegl1 libgl1-mesa-dri libopengl0 libpulse0 libnss3 libasound2 \
    libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 libxcb-shape0 \
    libxcb-xinerama0 libxcb-xkb1 libxcb-util1 libxcb-xfixes0 libxcb-shm0 libxcb-render0 libxcb-sync1 libxcb-glx0 \
    libx11-xcb1 libxcb-xinput0 libxkbcommon-x11-0 libxkbcommon0 libxi6 libxt6 libxrender1 libxfixes3 libxinerama1 \
    libfontconfig1 libfreetype6 libdbus-1-3 libsm6 libice6 libxcomposite1 libxcursor1 libxdamage1 libxrandr2 \
    libxss1 libxtst6 libgomp1 libgbm1 libdrm2 libpcre2-16-0 libpng16-16 libjpeg62-turbo libtiff6 libwebp7 \
    procps \
 && rm -rf /var/lib/apt/lists/*
# Slicer (500 MB; resume on transfer cuts)
RUN mkdir -p /opt/slicer && cd /opt/slicer \
 && for i in 1 2 3 4 5; do curl -sSL --retry 5 --retry-all-errors -C - -o slicer.tgz "$SLICER_URL" && break; sleep 5; done \
 && tar xzf slicer.tgz --strip-components=1 && rm slicer.tgz && test -x /opt/slicer/Slicer
# ModuleServer code (import, don't copy: LiveStoryLib is the mrson serializer the peer uses)
COPY ModuleServer/python /app/ModuleServer/python
COPY LiveStory/LiveStoryLib /app/LiveStory/LiveStoryLib
COPY ModuleServer/packaging/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh && useradd -m -u 1000 slicer && mkdir -p /session /state && chown -R slicer /session /state
USER slicer
ENV HOME=/home/slicer XDG_RUNTIME_DIR=/tmp/runtime-slicer PYTHONUNBUFFERED=1 \
    MODULESERVER_ROOT=/app MODULESERVER_STATE=/state/moduleserver.json MODULESERVER_SESSION_DIR=/session \
    MODULESERVER_ROLES=app,module MODULESERVER_HTTP_PORT=2131 MODULESERVER_WS_PORT=2132 MODULESERVER_GUI_PORT=2133 \
    MODULESERVER_MCP_PORT=0 MODULESERVER_SHOW=0 MODULESERVER_PLATFORM=xcb \
    MODULESERVER_IGNORE_MODULES=SimpleFilters
EXPOSE 2131 2132 2133
HEALTHCHECK --interval=15s --start-period=180s CMD test -f /state/moduleserver.json || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
