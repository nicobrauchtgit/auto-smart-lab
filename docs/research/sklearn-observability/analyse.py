import json, glob, os, statistics as st

rows = []
for path in sorted(glob.glob(os.path.join(os.path.dirname(__file__), "obs-*.jsonl"))):
    ev = [json.loads(l) for l in open(path) if l.strip()]
    case = os.path.basename(path)[4:-6]
    wall = max(e["at"] for e in ev)
    outs = [e["at"] for e in ev if e["kind"] == "output"]
    res = [e for e in ev if e["kind"] == "resource" and e.get("cpu_pct") is not None]
    marks = [0.0] + outs + [wall]
    gaps = [b - a for a, b in zip(marks, marks[1:])]
    maxgap = max(gaps) if gaps else wall
    gi = gaps.index(maxgap); lo, hi = marks[gi], marks[gi + 1]
    during = [r["cpu_pct"] for r in res if lo <= r["at"] <= hi]
    rows.append(dict(case=case, wall=wall, lines=len(outs), maxgap=maxgap,
                     p50=st.median(gaps) if gaps else 0,
                     cpu_gap=st.median(during) if during else None,
                     cpu_all=st.median([r["cpu_pct"] for r in res]) if res else None,
                     rss=max((r["rss_mb"] for r in res), default=0),
                     procs=max((r["processes"] for r in res), default=0),
                     killed=any(e["kind"] == "group_kill" for e in ev)))

h = f"{'case':24s}{'wall':>7s}{'lines':>7s}{'maxgap':>8s}{'p50gap':>8s}{'cpu@maxgap':>12s}{'cpu med':>9s}{'peakRSS':>9s}{'procs':>6s}"
print(h); print("-" * len(h))
for r in rows:
    cg = f"{r['cpu_gap']:.0f}%" if r["cpu_gap"] is not None else "n/a"
    ca = f"{r['cpu_all']:.0f}%" if r["cpu_all"] is not None else "n/a"
    print(f"{r['case']:24s}{r['wall']:7.1f}{r['lines']:7d}{r['maxgap']:8.1f}{r['p50']:8.2f}"
          f"{cg:>12s}{ca:>9s}{r['rss']:8.0f}M{r['procs']:6d}" + ("  KILLED" if r["killed"] else ""))
