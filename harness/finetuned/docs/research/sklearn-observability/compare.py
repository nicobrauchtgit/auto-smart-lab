import json, glob, os, statistics as st
from collections import defaultdict

def summarise(path):
    ev = [json.loads(l) for l in open(path) if l.strip()]
    wall = max(e["at"] for e in ev)
    outs = [e["at"] for e in ev if e["kind"] == "output"]
    res = [e for e in ev if e["kind"] == "resource" and e.get("cpu_pct") is not None]
    # first real output marks the end of the silent import+load prelude
    prelude = outs[0] if outs else wall
    marks = [0.0] + outs + [wall]
    gaps = [b - a for a, b in zip(marks, marks[1:])]
    # exclude the prelude from the "silence during work" statistic
    work_gaps = gaps[1:] if len(gaps) > 1 else gaps
    return dict(wall=wall, lines=len(outs), prelude=prelude,
                maxgap=max(work_gaps) if work_gaps else 0.0,
                cpu=st.median([r["cpu_pct"] for r in res]) if res else None,
                rss=max((r["rss_mb"] for r in res), default=0))

data = defaultdict(dict)
for p in sorted(glob.glob(os.path.join(os.path.dirname(__file__), "obs-spam*.jsonl"))):
    task, case = os.path.basename(p)[4:-6].split("-", 1)
    data[case][task] = summarise(p)

hdr = f"{'case':22s}|{'wall s':>15s}|{'prelude s':>14s}|{'max gap in work':>17s}|{'lines':>11s}|{'peak RSS':>13s}"
print(hdr); print("-" * len(hdr))
print(f"{'':22s}|{'spam1':>7s}{'spam2':>8s}|{'spam1':>6s}{'spam2':>8s}|{'spam1':>8s}{'spam2':>9s}|{'sp1':>5s}{'sp2':>6s}|{'sp1':>6s}{'sp2':>7s}")
print("-" * len(hdr))
for case in sorted(data):
    a, b = data[case].get("spam1"), data[case].get("spam2")
    if not (a and b): continue
    print(f"{case:22s}|{a['wall']:7.1f}{b['wall']:8.1f}|{a['prelude']:6.1f}{b['prelude']:8.1f}"
          f"|{a['maxgap']:8.1f}{b['maxgap']:9.1f}|{a['lines']:5d}{b['lines']:6d}"
          f"|{a['rss']:5.0f}M{b['rss']:6.0f}M")
