"""Refresh page-labelled text and checksums for declared course PDFs.

Run through ./dev with the finetuned Python environment:
    ./dev python resources/extract_slides.py resources/01-spam
"""
import hashlib
import json
import logging
from pathlib import Path
import sys

import pypdf


def extract(directory: Path) -> None:
    manifest_path = directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    for entry in manifest["files"]:
        if entry["media_type"] != "application/pdf":
            continue
        pdf = directory / entry["file"]
        pages = list(pypdf.PdfReader(pdf).pages)
        text = pdf.with_suffix(".txt")
        text.write_text("\n\n".join(
            f"--- Page {index} ---\n{page.extract_text() or '[No extractable text]'}"
            for index, page in enumerate(pages, 1)
        ) + "\n")
        for item in manifest["files"]:
            if item["file"] in (pdf.name, text.name):
                item["pages"] = len(pages)
                item["sha256"] = hashlib.sha256((directory / item["file"]).read_bytes()).hexdigest()
    manifest["extraction"] = {"library": "pypdf", "version": pypdf.__version__, "mode": "plain", "page_markers": True}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    logging.getLogger("pypdf").setLevel(logging.ERROR)
    extract(Path(sys.argv[1]))
