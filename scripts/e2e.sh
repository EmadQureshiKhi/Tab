#!/usr/bin/env bash
#
# Runs the Playwright suite on a host Playwright does not officially support.
#
# Playwright ships no browser build for Ubuntu 26.04 and refuses to install one, so
# the browser is fetched under a platform override and the five shared libraries it
# needs are unpacked from their .deb packages into a cache directory. Neither step
# needs root, which is the point: the sandbox has none.
#
# Everything here is idempotent. A second run downloads nothing.
set -euo pipefail

CACHE="${PW_LIB_CACHE:-$HOME/.cache/pw-libs}"
LIBS="$CACHE/root/usr/lib/x86_64-linux-gnu"
PLATFORM="${PLAYWRIGHT_HOST_PLATFORM_OVERRIDE:-ubuntu24.04-x64}"

if [ ! -d "$LIBS" ]; then
  echo "e2e: unpacking browser libraries into $CACHE (no root needed)"
  mkdir -p "$CACHE/debs"
  ( cd "$CACHE/debs" && apt-get download libnss3 libnspr4 libasound2t64 )
  for deb in "$CACHE"/debs/*.deb; do dpkg-deb -x "$deb" "$CACHE/root"; done
fi

# `install` validates host requirements and exits non-zero on this OS even after the
# download succeeds, so its failure is expected and the binary check below is what
# actually decides whether we can run.
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="$PLATFORM" \
  pnpm --filter @tabai/app exec playwright install chromium >/dev/null 2>&1 || true

BROWSER="$(find "$HOME/.cache/ms-playwright" -maxdepth 3 -path '*chrome-linux/chrome' -type f 2>/dev/null | head -1)"
if [ -z "$BROWSER" ]; then
  echo "e2e: no chromium binary under ~/.cache/ms-playwright, and the install could not provide one" >&2
  exit 2
fi

export LD_LIBRARY_PATH="$LIBS:${LD_LIBRARY_PATH:-}"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$BROWSER"
export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="$PLATFORM"

echo "e2e: chromium at $BROWSER"
exec pnpm --filter @tabai/app exec playwright test "$@"
