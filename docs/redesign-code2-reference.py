"""Hand-made reference for code2: cluster the scripts with known families without using the labels, score with ARI."""
import json, sys, time, zipfile, resource
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.decomposition import TruncatedSVD
from sklearn.preprocessing import normalize
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics import adjusted_rand_score
data = sys.argv[1]; t0 = time.perf_counter()
labels = dict(line.strip().rsplit(";", 1) for line in open(f"{data}/php-train.labels"))
with zipfile.ZipFile(f"{data}/php-train.zip") as z:
    names = [n for n in z.namelist() if n in labels]
    docs = [z.read(n).decode("latin-1") for n in names]
y = [labels[n] for n in names]
out = {"scripts": len(docs), "families": len(set(y)), "results": {}}
for name, kw in {"word tokens": dict(analyzer="word", token_pattern=r"[A-Za-z_$][A-Za-z0-9_]{2,}", max_features=50000),
                 "char 4-grams": dict(analyzer="char", ngram_range=(4, 4), max_features=50000)}.items():
    t = time.perf_counter()
    X = TfidfVectorizer(sublinear_tf=True, min_df=2, **kw).fit_transform(docs)
    Z = normalize(TruncatedSVD(100, random_state=0).fit_transform(X))
    row = {}
    for link, k in [("average", None), ("ward", 4), ("ward", 6), ("ward", 10)]:
        model = AgglomerativeClustering(n_clusters=k, linkage=link, metric="cosine", distance_threshold=0.7) if k is None else AgglomerativeClustering(n_clusters=k, linkage=link)
        pred = model.fit_predict(Z)
        row[f"{link} k={k or 'threshold 0.7'}"] = {"ari": round(adjusted_rand_score(y, pred), 3), "clusters": int(len(set(pred)))}
    row["seconds"] = round(time.perf_counter() - t, 1); out["results"][name] = row
out["total_seconds"] = round(time.perf_counter() - t0, 1); out["peak_rss_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
print(json.dumps(out, indent=1))
