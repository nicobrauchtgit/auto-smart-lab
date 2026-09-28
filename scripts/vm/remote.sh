#!/usr/bin/env bash
# Run and monitor the agent on the lab VM from your own machine. Needs the TU VPN.
#
#   scripts/vm/remote.sh check                 can we reach the VM?
#   scripts/vm/remote.sh deploy                install/update everything on the VM, copy secrets
#   scripts/vm/remote.sh fetch <unit-slug>     fetch one unit's material + data on the VM (saves disk)
#   scripts/vm/remote.sh start [solve-units args]   start a detached batch run (tmux session "agent")
#   scripts/vm/remote.sh status [--watch]      live summary: batch table, phase, session, API quota
#   scripts/vm/remote.sh logs                  follow the log of the task that is running now
#   scripts/vm/remote.sh attach                watch the run's terminal, read-only (Ctrl-b d to leave)
#   scripts/vm/remote.sh stop                  interrupt the run (Ctrl-C), then close the session
#   scripts/vm/remote.sh pull                  copy the VM's logs/ to ./logs/vm/<host>/
#   scripts/vm/remote.sh shell                 interactive shell in the repo on the VM
#
# Config via env: VM_HOST (default stud03@stud03.smartlab.mlsec.tu-berlin.de),
# VM_REPO (default ~/auto-smart-lab on the VM).
set -euo pipefail

VM_HOST="${VM_HOST:-stud03@stud03.smartlab.mlsec.tu-berlin.de}"
VM_REPO="${VM_REPO:-auto-smart-lab}"   # relative to the VM user's home
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SESSION=agent
SSH_OPTS=(-o ConnectTimeout=15 -o ServerAliveInterval=30)

# Remote prologue: node on PATH, secrets loaded, cwd = repo.
# The lab's ~/env venv (numpy, sklearn, ...) is activated exactly as a student's login shell does.
PRE='export PATH="$HOME/.local/node/bin:$PATH"; [ -f "$HOME/env/bin/activate" ] && . "$HOME/env/bin/activate"; cd "$HOME/'"$VM_REPO"'" || exit 1; set -a; [ -f .env ] && . ./.env; set +a;'

rssh()  { ssh "${SSH_OPTS[@]}" "$VM_HOST" "$@"; }
rssht() { ssh -t "${SSH_OPTS[@]}" "$VM_HOST" "$@"; }
die()   { echo "error: $*" >&2; exit 1; }

check() {
	if ssh "${SSH_OPTS[@]}" -o BatchMode=yes "$VM_HOST" true 2>/dev/null; then
		echo "reachable: $VM_HOST"
	else
		die "cannot reach $VM_HOST over SSH. Connect the TU VPN first (the VM has a private 10.x address)."
	fi
}

cmd="${1:-help}"; shift || true
case "$cmd" in
check) check ;;

deploy)
	check
	echo "== bootstrap on $VM_HOST"
	rssh "REPO_DIR=\$HOME/$VM_REPO bash -s" < "$HERE/bootstrap.sh" || echo "(bootstrap reported failures — see above)"
	echo "== copying secrets"
	[[ -f "$ROOT/.env" ]] || die "no .env in $ROOT"
	rssh "mkdir -p ~/.pi/agent ~/$VM_REPO && chmod 700 ~/.pi"
	scp -q "${SSH_OPTS[@]}" "$ROOT/.env" "$VM_HOST:$VM_REPO/.env"
	scp -q "${SSH_OPTS[@]}" "$HOME/.pi/agent/models.json" "$VM_HOST:.pi/agent/models.json"
	[[ -f "$HOME/.pi/agent/settings.json" ]] && scp -q "${SSH_OPTS[@]}" "$HOME/.pi/agent/settings.json" "$VM_HOST:.pi/agent/settings.json"
	rssh "chmod 600 ~/$VM_REPO/.env ~/.pi/agent/*.json"
	echo "== smoke test on the VM"
	rssh "$PRE"' npm run -s status | head -3; python3 -c "
import json, os, urllib.request, urllib.error
req = urllib.request.Request(\"https://chat-ai.academiccloud.de/v1/chat/completions\", data=json.dumps({\"model\": \"qwen3-coder-next\", \"messages\": [{\"role\": \"user\", \"content\": \"hi\"}], \"max_tokens\": 1}).encode(), headers={\"Authorization\": \"Bearer \" + os.environ.get(\"GWDG_API_KEY\", \"\"), \"Content-Type\": \"application/json\"})
try: r = urllib.request.urlopen(req, timeout=20); code, h = r.status, r.headers
except urllib.error.HTTPError as e: code, h = e.code, e.headers
print(f\"GWDG completion with key: HTTP {code}, remaining month={h.get(\"x-ratelimit-remaining-month\")} day={h.get(\"x-ratelimit-remaining-day\")}\")
"; python3 agent/setup/fetch_lab.py login >/dev/null 2>&1 && echo "lab login: ok" || echo "lab login: FAILED"'
	;;

fetch)
	unit="${1:-}"; [[ -n "$unit" ]] || die "usage: remote.sh fetch <unit-slug|title>  (e.g. malicious-code-in-documents)"
	rssh "$PRE"' python3 agent/setup/fetch_units.py --unit '"$(printf %q "$unit")"
	;;

start)
	check
	args=$(printf ' %q' "$@")
	stamp=$(date +%Y%m%d-%H%M%S)
	rssh "$PRE"' mkdir -p logs
		if command -v tmux >/dev/null; then
			tmux has-session -t '"$SESSION"' 2>/dev/null && { echo "a run is already active (tmux session '"$SESSION"'). Use: remote.sh stop"; exit 1; }
			tmux new-session -d -s '"$SESSION"' -x 200 -y 50 "bash -lc '\''$(printf %q "$PRE") npm run solve-units --'"$args"' 2>&1 | tee -a logs/vm-run-'"$stamp"'.log; echo; echo run finished, exit \$?; sleep 86400'\''"
			echo "started in tmux session '"$SESSION"' on $(hostname)"
		else
			pgrep -f "solve_units.ts" >/dev/null && { echo "a run is already active"; exit 1; }
			nohup setsid bash -c "npm run solve-units --'"$args"'" > logs/vm-run-'"$stamp"'.log 2>&1 < /dev/null &
			echo "started with nohup (pid $!) on $(hostname); no tmux, so use status/logs instead of attach"
		fi
		echo "console log: logs/vm-run-'"$stamp"'.log"'
	echo "monitor with: scripts/vm/remote.sh status --watch"
	;;

status)
	if [[ "${1:-}" == "--watch" ]]; then
		# Poll from here instead of a remote --watch so a flaky VPN just skips a frame.
		while true; do
			out=$(rssh "$PRE npm run -s status -- ${*:2}" 2>&1) || out="(VM unreachable at $(date +%H:%M:%S) — VPN down? retrying)"
			printf '\033[2J\033[H%s\n\n(%s, refreshing every 15 s, Ctrl-C to stop)\n' "$out" "$VM_HOST"
			sleep 15
		done
	else
		rssh "$PRE npm run -s status -- $*"
	fi
	;;

logs)
	rssht "$PRE"' f=$(python3 -c "import json;print(json.load(open(\"logs/status/run.json\")).get(\"currentLog\") or \"\")" 2>/dev/null); [ -z "$f" ] && f=$(ls -t logs/vm-run-*.log 2>/dev/null | head -1); [ -z "$f" ] && { echo "no log yet"; exit 1; }; echo "== $f"; tail -n 40 -F "$f" | grep --line-buffered -v "still running"'
	;;

attach)
	rssht "tmux attach -r -t $SESSION" || echo "no tmux session '$SESSION' (not running, or started without tmux)"
	;;

stop)
	rssh "if tmux has-session -t $SESSION 2>/dev/null; then tmux send-keys -t $SESSION C-c; sleep 5; tmux kill-session -t $SESSION; echo stopped; else pkill -INT -f solve_units.ts && echo 'sent SIGINT' || echo 'nothing running'; fi"
	echo "note: an interrupted submission may have spent an attempt; the lab's task page is authoritative."
	;;

pull)
	dest="$ROOT/logs/vm/$VM_HOST"; mkdir -p "$dest"
	rsync -az --info=stats1 -e "ssh ${SSH_OPTS[*]}" "$VM_HOST:$VM_REPO/logs/" "$dest/" 2>/dev/null \
		|| rsync -az -e "ssh ${SSH_OPTS[*]}" "$VM_HOST:$VM_REPO/logs/" "$dest/"
	echo "copied to ${dest#$ROOT/}"
	;;

shell) rssht "$PRE exec \$SHELL -l" ;;

*) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
