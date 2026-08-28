#!/bin/sh
# Xvfb (with GLX so Qt/VTK get a software GL context) + stock Slicer running bootstrap.py, invisible.
set -e
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
Xvfb :9 -screen 0 2560x1600x24 +extension GLX -nolisten tcp >/tmp/xvfb.log 2>&1 &
export DISPLAY=:9 QT_QPA_PLATFORM=xcb LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe
sleep 1
exec /opt/slicer/Slicer --no-splash --ignore-slicerrc \
  --modules-to-ignore "${MODULESERVER_IGNORE_MODULES:-SimpleFilters}" \
  --python-script /app/ModuleServer/python/bootstrap.py "$@"
