#!/usr/bin/env bash
set -euo pipefail

# Create/refresh a SmartLab authenticated session cookie file.
# Required:
#   LAB_USER='...' LAB_PASS='...' ./refresh_lab_session.sh
# Optional:
#   LAB_INSECURE_TLS=1       accept the lab's self-signed TLS certificate
#   LAB_COOKIE_FILE=...      default: lab-cookies.txt
#   LAB_BASE_URL=...         default: https://lab-test.smartlab.mlsec.tu-berlin.de/

cd "$(dirname "$0")"

if [[ -z "${LAB_USER:-}" || -z "${LAB_PASS:-}" ]]; then
  echo "Set LAB_USER and LAB_PASS first, e.g.:" >&2
  echo "  LAB_USER='your_username' LAB_PASS='your_password' LAB_INSECURE_TLS=1 $0" >&2
  exit 2
fi

insecure_arg=()
if [[ "${LAB_INSECURE_TLS:-}" =~ ^(1|true|TRUE|yes|YES|on|ON)$ ]]; then
  insecure_arg=(--insecure)
fi

python3 fetch_lab.py "${insecure_arg[@]}" login
