"""Supervisor stand-in: spawn a trial detached in its own process group, timestamp
every stdout line, and sample process-group CPU/RSS the way a TS supervisor would
(shelling out to ps -- no psutil).

Emits one JSONL observation file per case."""
from __future__ import annotations
import json, os, subprocess, sys, threading, time
from pathlib import Path

SAMPLE_SECONDS = 0.25


from procinfo import sample_group


def run(case: str, out_path: Path, python: str, cwd: str, deadline: float = float(os.environ.get("DEADLINE", 90.0))):
    events: list[dict] = []
    started = time.time()

    def record(kind, **fields):
        events.append({"kind": kind, "at": round(time.time() - started, 4), **fields})

    child = subprocess.Popen(
        [python, "-u", str(Path(__file__).parent / "fit_case.py"), case],
        cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, start_new_session=True,  # own process group
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    pgid = os.getpgid(child.pid)
    record("spawned", pid=child.pid, pgid=pgid)

    def drain():
        for line in child.stdout:
            line = line.rstrip("\n")
            record("output", stream="stdout",
                   callback=line.startswith("CALLBACK"), text=line[:200])

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()

    prev = None
    killed = False
    while child.poll() is None:
        if time.time() - started > deadline:
            # exercises the group kill: SIGTERM the whole group, not just the child
            record("group_kill", pgid=pgid, members=len(__import__("procinfo").pids_in_group(pgid)))
            os.killpg(pgid, 15)
            killed = True
            time.sleep(1.0)
            if child.poll() is None:
                os.killpg(pgid, 9)
            break
        s = sample_group(pgid)
        if s:
            now = time.time()
            pct = None
            if prev:
                dt = now - prev[0]
                if dt > 0:
                    pct = 100.0 * (s["cpu_seconds"] - prev[1]) / dt
            record("resource", processes=s["processes"], rss_mb=round(s["rss_kb"] / 1024, 1),
                   cpu_pct=None if pct is None else round(pct, 1))
            prev = (now, s["cpu_seconds"])
        time.sleep(SAMPLE_SECONDS)

    reader.join(timeout=5)
    record("exited", code=child.returncode, killed=killed)
    out_path.write_text("\n".join(json.dumps(e) for e in events))
    return events


TASK = os.environ.get("TASK", "spam1")


if __name__ == "__main__":
    scratch = Path(__file__).parent
    python, cwd = sys.argv[1], sys.argv[2]
    for case in sys.argv[3:]:
        t = time.time()
        ev = run(case, scratch / f"obs-{TASK}-{case}.jsonl", python, cwd)
        outs = sum(1 for e in ev if e["kind"] == "output")
        print(f"{case:26s} {time.time()-t:6.1f}s  output_lines={outs:5d}  samples={sum(1 for e in ev if e['kind']=='resource')}")
