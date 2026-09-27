#!/usr/bin/env bash
# Runs ON THE VM (piped over ssh by scripts/vm/remote.sh deploy). Idempotent; no sudo needed.
#
#  - checks network access (lab, GWDG model API, GitHub, nodejs.org, npm registry)
#  - installs Node.js into ~/.local/node if node >= 20 is missing
#  - clones or fast-forwards the repo into $REPO_DIR and runs npm ci
#  - reports python3, tmux, disk space and anything that will block a run
#
# Secrets (.env, ~/.pi/agent/models.json) are copied separately by remote.sh.
set -uo pipefail

REPO_URL="${REPO_URL:-https://github.com/nicobrauchtgit/auto-smart-lab.git}"
REPO_DIR="${REPO_DIR:-$HOME/auto-smart-lab}"
REPO_BRANCH="${REPO_BRANCH:-main}"
NODE_VERSION="${NODE_VERSION:-v24.16.0}"
NODE_HOME="$HOME/.local/node"
MIN_FREE_GB="${MIN_FREE_GB:-30}"

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; WARNINGS=$((WARNINGS+1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILURES=$((FAILURES+1)); }
WARNINGS=0; FAILURES=0

echo "== host: $(hostname)  $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}")  $(uname -m)  $(nproc 2>/dev/null) cpu  $(free -h 2>/dev/null | awk '/Mem:/{print $2}') ram"

echo "== network"
probe() { # name url
	local code; code=$(curl -sk -m 12 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null)
	if [[ "$code" =~ ^[23] || "$code" == "401" ]]; then ok "$1 ($code)"; else fail "$1 unreachable (HTTP $code): $2"; fi
}
probe "SmartLab"      "https://lab-test.smartlab.mlsec.tu-berlin.de/"
probe "GWDG model API" "https://chat-ai.academiccloud.de/v1/models"
probe "GitHub"        "https://github.com"
probe "nodejs.org"    "https://nodejs.org/dist/index.json"
probe "npm registry"  "https://registry.npmjs.org/tsx"

echo "== node"
export PATH="$NODE_HOME/bin:$PATH"
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
if [[ "$(node_major)" -ge 20 ]] 2>/dev/null; then
	ok "node $(node -v) at $(command -v node)"
else
	case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) arch="" ;; esac
	if [[ -z "$arch" ]]; then fail "unsupported arch $(uname -m) for the Node tarball"; else
		tarball="node-${NODE_VERSION}-linux-${arch}.tar.xz"
		echo "  installing $tarball into $NODE_HOME"
		tmp=$(mktemp -d)
		if curl -fsSL -m 300 "https://nodejs.org/dist/${NODE_VERSION}/${tarball}" -o "$tmp/$tarball" && mkdir -p "$NODE_HOME" \
			&& tar -xJf "$tmp/$tarball" -C "$NODE_HOME" --strip-components=1; then
			ok "node $(node -v) installed"
		else
			fail "could not install Node (no access to nodejs.org, or no xz). Install Node >= 20 manually."
		fi
		rm -rf "$tmp"
	fi
	for rc in "$HOME/.profile" "$HOME/.bashrc"; do
		grep -q '.local/node/bin' "$rc" 2>/dev/null || echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> "$rc"
	done
fi

echo "== python"
if command -v python3 >/dev/null; then
	pv=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')
	python3 -c 'import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)' && ok "python3 $pv" || fail "python3 $pv is too old (need >= 3.10)"
else
	fail "python3 missing"
fi

echo "== tools"
command -v tmux >/dev/null && ok "tmux $(tmux -V | cut -d' ' -f2)" || warn "tmux missing: runs will use nohup (no live attach; status/logs still work)"
command -v git  >/dev/null && ok "git" || fail "git missing"

echo "== repo"
if command -v git >/dev/null; then
	if [[ -d "$REPO_DIR/.git" ]]; then
		git -C "$REPO_DIR" fetch -q origin && git -C "$REPO_DIR" checkout -q "$REPO_BRANCH" \
			&& git -C "$REPO_DIR" merge -q --ff-only "origin/$REPO_BRANCH" \
			&& ok "updated $REPO_DIR to $(git -C "$REPO_DIR" log --oneline -1 | cut -c1-60)" \
			|| fail "could not fast-forward $REPO_DIR (local changes?)"
	else
		git clone -q -b "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR" && ok "cloned into $REPO_DIR" || fail "git clone failed"
	fi
	if [[ -f "$REPO_DIR/package.json" ]] && command -v npm >/dev/null; then
		(cd "$REPO_DIR" && npm install --no-audit --no-fund --loglevel=error >/tmp/npm-install.log 2>&1) \
			&& ok "npm install" || fail "npm install failed (see /tmp/npm-install.log)"
	fi
fi

echo "== disk"
free_gb=$(df -Pk "$HOME" | awk 'NR==2{print int($4/1048576)}')
if [[ "$free_gb" -ge "$MIN_FREE_GB" ]]; then ok "${free_gb} GB free in $HOME"
else warn "only ${free_gb} GB free in $HOME; the malware units need ~12 GB each once extracted. Fetch one unit at a time."; fi

echo "== secrets"
[[ -f "$REPO_DIR/.env" ]] && ok ".env present" || warn ".env missing (remote.sh deploy copies it)"
[[ -f "$HOME/.pi/agent/models.json" ]] && ok "~/.pi/agent/models.json present" || warn "models.json missing (remote.sh deploy copies it)"

echo "== antivirus (quarantines malware samples)"
if pgrep -fl 'clamd|freshclam|mdatp|wdavdaemon|falcon|sophos' >/dev/null 2>&1; then
	warn "an AV process is running: $(pgrep -fl 'clamd|mdatp|wdavdaemon|falcon|sophos' | head -1)"
else
	ok "no known AV daemon running"
fi

echo
echo "bootstrap finished: $FAILURES failure(s), $WARNINGS warning(s)"
exit $(( FAILURES > 0 ? 1 : 0 ))
