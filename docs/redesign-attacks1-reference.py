"""Hand-made reference for attacks1: label-free anomaly scores on the training images, scored against the hidden truth (never given to agents)."""
import io, json, sys, time, zipfile, resource
import numpy as np
from PIL import Image
from sklearn.ensemble import IsolationForest
from sklearn.metrics import roc_auc_score, average_precision_score, balanced_accuracy_score
data, truth_path = sys.argv[1], sys.argv[2]; t0 = time.perf_counter()
truth = dict(line.strip().rsplit(";", 1) for line in open(truth_path))
names, feats, shapes = [], [], set()
with zipfile.ZipFile(f"{data}/adv-train.zip") as z:
    for n in sorted(z.namelist()):
        if n.endswith("/"): continue
        a = np.asarray(Image.open(io.BytesIO(z.read(n))).convert("RGB"), dtype=np.float32) / 255.0
        shapes.add(a.shape); g = a.mean(axis=2)
        lap = np.abs(4 * g[1:-1, 1:-1] - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:])
        tv = np.abs(np.diff(a, axis=0)).mean() + np.abs(np.diff(a, axis=1)).mean()
        # residual after a 3x3 mean filter: adversarial noise is high-frequency
        pad = np.pad(g, 1, mode="edge"); blur = sum(pad[i:i + g.shape[0], j:j + g.shape[1]] for i in range(3) for j in range(3)) / 9
        feats.append([lap.mean(), tv, np.abs(g - blur).mean(), a.std(), len(z.read(n))]); names.append(n)
X = np.array(feats); y = np.array([int(truth[n] != "0") for n in names])
out = {"images": len(names), "shapes": [list(s) for s in shapes], "attacks": int(y.sum()), "scores": {}}
def report(score):
    k = int(round(len(y) * 0.04)); flagged = np.zeros(len(y), int); flagged[np.argsort(-score)[:k]] = 1
    return {"roc_auc": round(roc_auc_score(y, score), 3), "average_precision": round(average_precision_score(y, score), 3), "balanced_accuracy_top4pct": round(balanced_accuracy_score(y, flagged), 3)}
for i, name in enumerate(["laplacian energy", "total variation", "blur residual", "pixel std", "png bytes"]): out["scores"][name] = report(X[:, i])
iso = IsolationForest(n_estimators=300, random_state=0).fit((X - X.mean(0)) / X.std(0)); out["scores"]["isolation forest on the five"] = report(-iso.score_samples((X - X.mean(0)) / X.std(0)))
out["total_seconds"] = round(time.perf_counter() - t0, 1); out["peak_rss_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
print(json.dumps(out, indent=1))
