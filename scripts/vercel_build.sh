#!/bin/sh
# Vercel build command (see vercel.json): build the static web version into
# dist/ with any Python >= 3.10 on the build image, or one fetched by uv.
set -e
for py in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
    echo "using $("$py" --version)"
    exec "$py" scripts/build_site.py dist
  fi
done
if command -v uv >/dev/null 2>&1; then
  exec uv run --no-project --python 3.12 scripts/build_site.py dist
fi
echo "Python 3.10+ not found on the build image" >&2
exit 1
