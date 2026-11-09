"""Small harness integration fixture; never imported by the production pipeline."""

import zipfile

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import FunctionTransformer, Pipeline


def read_text(frame):
    texts = []
    for descriptor in frame["input"]:
        with zipfile.ZipFile(descriptor["archive"]) as archive:
            texts.append(archive.read(descriptor["member"]).decode("utf-8", "replace"))
    return texts


def build_pipeline(context):
    return Pipeline([
        ("text", FunctionTransformer(read_text, validate=False)),
        ("tfidf", TfidfVectorizer(ngram_range=(1, 2))),
        ("model", LogisticRegression(C=context["parameters"].get("c", 1.0), max_iter=200)),
    ])
