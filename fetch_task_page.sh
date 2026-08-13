#!/usr/bin/env bash
set -euo pipefail

# Download the SmartLab task page with wget.
# Usage:
#   ./fetch_task_page.sh [output_dir]
#
# Optional, if the page requires an authenticated browser session:
#   COOKIE_FILE=/path/to/cookies.txt ./fetch_task_page.sh
# The cookie file must be in Netscape cookie format, which wget understands.
# You can create one with:
#   LAB_USER=... LAB_PASS=... ./fetch_lab.py --insecure login
#
# If the lab TLS certificate is self-signed:
#   LAB_INSECURE_TLS=1 ./fetch_task_page.sh

URL="https://lab-test.smartlab.mlsec.tu-berlin.de/units/8a84a7b83020423085b3595403848ffb/tasks/c32fae0bc0ea4c018b9aac9e0be4145c/"
OUT_DIR="${1:-downloaded_task_page}"
COOKIE_FILE="${COOKIE_FILE:-lab-cookies.txt}"
LAB_INSECURE_TLS="${LAB_INSECURE_TLS:-}"

mkdir -p "$OUT_DIR"

wget_args=(
  --directory-prefix="$OUT_DIR"
  --page-requisites
  --convert-links
  --adjust-extension
  --no-parent
  --domains=lab-test.smartlab.mlsec.tu-berlin.de
  --user-agent="Mozilla/5.0 wget-page-fetcher"
)

if [[ -n "$COOKIE_FILE" && -f "$COOKIE_FILE" ]]; then
  wget_args+=(--load-cookies="$COOKIE_FILE")
fi

if [[ "$LAB_INSECURE_TLS" =~ ^(1|true|TRUE|yes|YES|on|ON)$ ]]; then
  wget_args+=(--no-check-certificate)
fi

wget "${wget_args[@]}" "$URL"

echo "Downloaded page into: $OUT_DIR"
