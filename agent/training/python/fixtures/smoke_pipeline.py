"""Small harness integration fixture; never imported by the production pipeline."""

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import FunctionTransformer, Pipeline


def build_pipeline(context):
    return Pipeline([
        ("text", FunctionTransformer(lambda frame: frame["text"], validate=False)),
        ("tfidf", TfidfVectorizer(ngram_range=(1, 2))),
        ("model", LogisticRegression(C=context["parameters"].get("c", 1.0), max_iter=200)),
    ])
