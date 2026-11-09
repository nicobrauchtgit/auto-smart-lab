"""Hand-made reference for spam1: binary TF-IDF + linear model, 5-fold stratified CV, timed."""
import json, sys, time, zipfile, resource
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.svm import LinearSVC
from sklearn.pipeline import make_pipeline
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import balanced_accuracy_score

data = sys.argv[1]
t0 = time.perf_counter()
labels = {}
for line in open(f"{data}/spam1-train.labels"):
    name, label = line.strip().rsplit(";", 1)
    labels[name] = int(label)
with zipfile.ZipFile(f"{data}/spam1-train.zip") as z:
    names = [n for n in z.namelist() if n in labels]
    docs = [z.read(n).decode("utf-8", errors="replace") for n in names]   # a plain list, never a NumPy string array
y = [labels[n] for n in names]
load = time.perf_counter() - t0
out = {"documents": len(docs), "load_seconds": round(load, 1), "models": {}}
cv = StratifiedKFold(5, shuffle=True, random_state=0)
candidates = {
    "word1 binary tfidf + LinearSVC": make_pipeline(TfidfVectorizer(binary=True, sublinear_tf=False), LinearSVC()),
    "word1-2 binary tfidf + LinearSVC": make_pipeline(TfidfVectorizer(binary=True, ngram_range=(1, 2), min_df=2), LinearSVC()),
    "word1 binary tfidf + LogReg": make_pipeline(TfidfVectorizer(binary=True), LogisticRegression(C=10, max_iter=2000)),
}
for name, model in candidates.items():
    t = time.perf_counter()
    pred = cross_val_predict(model, docs, y, cv=cv, n_jobs=1)
    out["models"][name] = {"balanced_accuracy": round(balanced_accuracy_score(y, pred), 4), "errors": int(sum(p != t_ for p, t_ in zip(pred, y))), "seconds": round(time.perf_counter() - t, 1)}
out["total_seconds"] = round(time.perf_counter() - t0, 1)
out["peak_rss_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
print(json.dumps(out, indent=1))
