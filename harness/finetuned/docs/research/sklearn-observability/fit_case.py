"""One trial fit, run as a supervised child. Prints nothing but the estimator's
own output plus CALLBACK lines, so the supervisor sees exactly what a real
agent-authored script would emit."""
from __future__ import annotations
import json, sys, time
from sklearn.pipeline import Pipeline
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.naive_bayes import MultinomialNB
from sklearn.svm import LinearSVC
from sklearn.linear_model import LogisticRegression, SGDClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.model_selection import GridSearchCV, cross_validate
from sklearn.callback import FitCallback, AutoPropagatedCallback

import os
TASK = os.environ.get("TASK", "spam1")
ROOT = {"spam1": "units/01-spam/spam-detection-with-machine-learning-50-points/data",
        "spam2": "units/01-spam/spam-detection-in-practice-50-points/data"}[TASK]


class AutoTap(FitCallback, AutoPropagatedCallback):
    """Same tap, but propagated from a meta-estimator into sub-estimators."""
    max_propagation_depth = 10

    def on_fit_task_begin(self, estimator, context, **kw):
        pass

    def on_fit_task_end(self, estimator, context, **kw):
        print("CALLBACK " + json.dumps({
            "t": time.time(),
            "estimator": type(estimator).__name__,
            "task": getattr(context, "task_name", None),
        }), flush=True)
        return False


class Tap(FitCallback):
    """What a supervised trial would attach: one line per task boundary."""
    def on_fit_task_begin(self, estimator, context, **kw):
        pass

    def on_fit_task_end(self, estimator, context, **kw):
        print("CALLBACK " + json.dumps({
            "t": time.time(),
            "estimator": type(estimator).__name__,
            "task": getattr(context, "task_name", None),
        }), flush=True)
        return False


def data(limit=None):
    from smartlab_eval import load_labelled
    X, y = load_labelled(f"{ROOT}/{TASK}-train.zip", f"{ROOT}/{TASK}-train.labels")
    if limit:
        X, y = X.iloc[:limit], y[:limit]
    return X.text.values, y


def tfidf(**kw):
    return TfidfVectorizer(max_features=kw.pop("max_features", 50_000), **kw)


CASES = {}
def case(fn):
    CASES[fn.__name__] = fn
    return fn


@case
def nb_full():
    X, y = data()
    Pipeline([("tf", tfidf()), ("clf", MultinomialNB())]).fit(X, y)


@case
def linearsvc_full():
    X, y = data()
    Pipeline([("tf", tfidf()), ("clf", LinearSVC(verbose=1))]).fit(X, y)


@case
def logreg_lbfgs_callbacks():
    X, y = data()
    p = Pipeline([("tf", tfidf()), ("clf", LogisticRegression(solver="lbfgs", max_iter=200))])
    p.set_callbacks(Tap())
    p.fit(X, y)


@case
def logreg_lbfgs_autoprop():
    X, y = data()
    p = Pipeline([("tf", tfidf()), ("clf", LogisticRegression(solver="lbfgs", max_iter=200))])
    p.set_callbacks(AutoTap())
    p.fit(X, y)


@case
def sgd_verbose():
    X, y = data()
    Pipeline([("tf", tfidf()),
              ("clf", SGDClassifier(verbose=1, max_iter=50, tol=None))]).fit(X, y)


@case
def mlp_verbose():
    X, y = data(6000)
    Pipeline([("tf", tfidf(max_features=5000)),
              ("clf", MLPClassifier(hidden_layer_sizes=(64,), max_iter=30, verbose=True))]).fit(X, y)


@case
def gridsearch_callbacks():
    X, y = data()
    gs = GridSearchCV(
        Pipeline([("tf", tfidf()), ("clf", LogisticRegression(solver="lbfgs", max_iter=100))]),
        {"clf__C": [0.1, 1.0, 10.0], "tf__ngram_range": [(1, 1), (1, 2)]},
        cv=3, n_jobs=1)
    gs.set_callbacks(Tap())
    gs.fit(X, y)


@case
def gridsearch_parallel():
    X, y = data()
    gs = GridSearchCV(
        Pipeline([("tf", tfidf()), ("clf", LogisticRegression(solver="lbfgs", max_iter=100))]),
        {"clf__C": [0.1, 1.0, 10.0], "tf__ngram_range": [(1, 1), (1, 2)]},
        cv=3, n_jobs=4)
    gs.set_callbacks(Tap())
    gs.fit(X, y)


@case
def crossval_silent():
    """The realistic default: cross_validate over an estimator with no telemetry."""
    X, y = data()
    cross_validate(Pipeline([("tf", tfidf()), ("clf", MultinomialNB())]), X, y, cv=5)


@case
def stuck_deadlock():
    """A trial that hangs: alive, zero CPU. The failure the heartbeat exists for."""
    import threading
    X, y = data(2000)
    lock = threading.Lock(); lock.acquire()
    print("about to deadlock", flush=True)
    lock.acquire()


@case
def stuck_busy():
    """Alive, pegged, producing nothing. Looks identical on the output channel."""
    X, y = data(2000)
    print("entering opaque region", flush=True)
    import numpy as np
    a = np.random.rand(1200, 1200)
    for _ in range(80):
        a = np.linalg.qr(a)[0]


@case
def pipeline_verbose():
    """Pipeline(verbose=True): does the container itself narrate the fit?"""
    X, y = data()
    Pipeline([("tf", tfidf()), ("clf", MultinomialNB())], verbose=True).fit(X, y)


@case
def pipeline_verbose_slow_tail():
    """Same, but the expensive work is the LAST step -- the realistic shape."""
    X, y = data()
    Pipeline([("tf", tfidf()),
              ("clf", LogisticRegression(solver="saga", max_iter=60, tol=1e-6))],
             verbose=True).fit(X, y)


@case
def nb_batched():
    """Same MultinomialNB, driven by the agent over batches instead of one fit().
    No loss exists -- it counts, it does not optimise -- but a learning curve does."""
    import numpy as np
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import balanced_accuracy_score
    X, y = data()
    Xtr, Xva, ytr, yva = train_test_split(X, y, test_size=0.2, stratify=y, random_state=0)
    vec = tfidf(); Vtr = vec.fit_transform(Xtr); Vva = vec.transform(Xva)
    print("PROGRESS " + json.dumps({"phase": "vectorised", "t": time.time()}), flush=True)
    clf = MultinomialNB(); classes = np.unique(ytr)
    n, batch = Vtr.shape[0], 1000
    for start in range(0, n, batch):
        clf.partial_fit(Vtr[start:start+batch], ytr[start:start+batch], classes=classes)
        seen = min(start + batch, n)
        print("PROGRESS " + json.dumps({
            "t": time.time(), "unit": "rows", "seen": seen, "total": n,
            "val_bacc": round(balanced_accuracy_score(yva, clf.predict(Vva)), 4),
        }), flush=True)


@case
def sgd_batched_loss():
    """SGD over batches: a real optimisation loss exists, so log it per batch."""
    import numpy as np
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import balanced_accuracy_score, log_loss
    X, y = data()
    Xtr, Xva, ytr, yva = train_test_split(X, y, test_size=0.2, stratify=y, random_state=0)
    vec = tfidf(); Vtr = vec.fit_transform(Xtr); Vva = vec.transform(Xva)
    clf = SGDClassifier(loss="log_loss", random_state=0); classes = np.unique(ytr)
    n, batch = Vtr.shape[0], 2000
    for epoch in range(8):
        for start in range(0, n, batch):
            clf.partial_fit(Vtr[start:start+batch], ytr[start:start+batch], classes=classes)
        print("PROGRESS " + json.dumps({
            "t": time.time(), "unit": "epoch", "completed": epoch + 1, "total": 8,
            "train_loss": round(log_loss(ytr, clf.predict_proba(Vtr)), 4),
            "val_bacc": round(balanced_accuracy_score(yva, clf.predict(Vva)), 4),
        }), flush=True)


if __name__ == "__main__":
    name = sys.argv[1]
    started = time.time()
    print(f"START {name} {started}", flush=True)
    CASES[name]()
    print(f"END {name} {time.time()} elapsed={time.time()-started:.2f}", flush=True)
