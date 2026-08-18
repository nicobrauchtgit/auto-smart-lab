#!/usr/bin/env python3
"""Fetch all units and tasks from the SmartLab lab and populate units/.

For each task, writes:
  units/<unit-slug>/<task-slug>/prompt.md   – task description as Markdown
  units/<unit-slug>/<task-slug>/data/       – extracted training data zips
  units/<unit-slug>/unit-intro.md           – unit description (if any)

Slugs are derived from the URL path (UUID hex segments) or from the breadcrumb
title when a human-readable name is available.

Usage:
  python3 agent/setup/fetch_units.py [--insecure] [--refresh] [--no-data]

Environment:
  LAB_USER, LAB_PASS   – credentials (LAB_COOKIE_FILE used as cache)
  LAB_INSECURE_TLS=1   – skip TLS verification
"""
from __future__ import annotations

import html
import json
import os
import re
import sys
import zipfile
from pathlib import Path
from urllib.parse import urljoin, urlparse
import argparse

# fetch_lab lives in the same directory; add it to path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_lab import BASE_URL, LabClient  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
UNITS_DIR = REPO_ROOT / "units"
CACHE_DIR = Path(__file__).resolve().parent / "downloaded_task_page"


# ---------------------------------------------------------------------------
# HTML helpers (stdlib only)
# ---------------------------------------------------------------------------

def _strip_tags(fragment: str) -> str:
    text = re.sub(r"<script[^>]*>.*?</script>", " ", fragment, flags=re.I | re.S)
    text = re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    return html.unescape(re.sub(r"\s+", " ", text).strip())


def _parse_links(page: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for m in re.finditer(r'<a\b[^>]*href="([^"]*)"[^>]*>(.*?)</a>', page, re.I | re.S):
        out.append((html.unescape(m.group(1)), _strip_tags(m.group(2))))
    return out


def _breadcrumb(page: str) -> list[str]:
    return [
        _strip_tags(m)
        for m in re.findall(r'<li[^>]*breadcrumb-item[^>]*>(.*?)</li>', page, re.I | re.S)
    ]


def _main_content(page: str) -> str:
    """Extract the main content div if present, otherwise return whole page."""
    m = re.search(r'<(?:div|main|article)[^>]*(?:id|class)="[^"]*(?:content|main|task|description)[^"]*"[^>]*>(.*?)</(?:div|main|article)>', page, re.I | re.S)
    return m.group(1) if m else page


def _html_to_md(fragment: str) -> str:
    """Very light HTML→Markdown conversion (stdlib-only, good-enough for task prompts)."""
    text = fragment

    # headings
    for level in range(6, 0, -1):
        text = re.sub(
            rf'<h{level}[^>]*>(.*?)</h{level}>',
            lambda m, l=level: "\n" + "#" * l + " " + _strip_tags(m.group(1)) + "\n",
            text, flags=re.I | re.S
        )

    # lists
    text = re.sub(r'<li[^>]*>(.*?)</li>', lambda m: "- " + _strip_tags(m.group(1)) + "\n", text, flags=re.I | re.S)

    # code blocks
    text = re.sub(r'<pre[^>]*><code[^>]*>(.*?)</code></pre>', lambda m: "\n```\n" + html.unescape(re.sub(r"<[^>]+>", "", m.group(1))) + "\n```\n", text, flags=re.I | re.S)
    text = re.sub(r'<code[^>]*>(.*?)</code>', lambda m: "`" + _strip_tags(m.group(1)) + "`", text, flags=re.I | re.S)

    # bold / italic
    text = re.sub(r'<(?:strong|b)[^>]*>(.*?)</(?:strong|b)>', lambda m: "**" + _strip_tags(m.group(1)) + "**", text, flags=re.I | re.S)
    text = re.sub(r'<(?:em|i)[^>]*>(.*?)</(?:em|i)>', lambda m: "*" + _strip_tags(m.group(1)) + "*", text, flags=re.I | re.S)

    # links
    text = re.sub(r'<a\b[^>]*href="([^"]*)"[^>]*>(.*?)</a>', lambda m: f"[{_strip_tags(m.group(2))}]({html.unescape(m.group(1))})", text, flags=re.I | re.S)

    # paragraphs / breaks
    text = re.sub(r'<br\s*/?>', "\n", text, flags=re.I)
    text = re.sub(r'<p[^>]*>(.*?)</p>', lambda m: "\n" + _strip_tags(m.group(1)) + "\n", text, flags=re.I | re.S)

    # strip remaining tags
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)

    # collapse excessive blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    return re.sub(r"-{2,}", "-", text).strip("-")


# ---------------------------------------------------------------------------
# Unit/task discovery helpers
# ---------------------------------------------------------------------------

def _unit_slug_from_url(unit_url: str, breadcrumb_title: str) -> str:
    """Derive a slug: prefer human-readable breadcrumb title, fallback to URL id."""
    if breadcrumb_title and breadcrumb_title not in ("<unknown unit>", ""):
        return _slugify(breadcrumb_title)
    parts = unit_url.rstrip("/").split("/")
    return parts[-2] if len(parts) >= 2 else parts[-1]


def _task_slug_from_url(task_url: str, breadcrumb_title: str) -> str:
    if breadcrumb_title and breadcrumb_title not in ("<unknown challenge>", ""):
        return _slugify(breadcrumb_title)
    return task_url.rstrip("/").split("/")[-1]


# ---------------------------------------------------------------------------
# Fetching with cache
# ---------------------------------------------------------------------------

def _cached_get(client: LabClient, url: str, cache_path: Path, refresh: bool) -> str:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if cache_path.exists() and cache_path.stat().st_size > 0 and not refresh:
        return cache_path.read_text(encoding="utf-8", errors="replace")
    response = client.get(url)
    cache_path.write_bytes(response.body)
    return response.text


# ---------------------------------------------------------------------------
# Core fetch logic
# ---------------------------------------------------------------------------

def _download_data(client: LabClient, download_urls: list[str], dest_dir: Path) -> list[Path]:
    """Download and extract zips into dest_dir. Returns list of written files."""
    written: list[Path] = []
    dest_dir.mkdir(parents=True, exist_ok=True)
    for url in download_urls:
        filename = urlparse(url).path.split("/")[-1] or "data.zip"
        local = dest_dir / filename
        if local.exists():
            print(f"    [skip] {filename} (already downloaded)")
            written.append(local)
            continue
        print(f"    [download] {url}")
        try:
            response = client.get(url)
        except Exception as exc:
            print(f"    [warn] failed to download {url}: {exc}")
            continue
        local.write_bytes(response.body)
        written.append(local)
        if filename.endswith(".zip"):
            try:
                with zipfile.ZipFile(local) as zf:
                    zf.extractall(dest_dir)
                print(f"    [extract] {filename} -> {dest_dir.relative_to(REPO_ROOT)}/")
            except zipfile.BadZipFile:
                print(f"    [warn] not a valid zip: {filename}")
    return written


def fetch_all(refresh: bool = False, insecure: bool = False, fetch_data: bool = True) -> int:
    client = LabClient(insecure_tls=insecure)
    units_url = urljoin(BASE_URL, "/units/")
    print(f"[fetch_units] Loading units index: {units_url}")
    units_page = _cached_get(client, units_url, CACHE_DIR / "units.html", refresh)

    # Find unit task-list links: /units/<uuid>/tasks/
    unit_task_links = list(dict.fromkeys(
        urljoin(BASE_URL, href)
        for href, _ in _parse_links(units_page)
        if re.search(r"/units/[0-9a-f-]+/tasks/?$", href)
    ))

    if not unit_task_links:
        print("[fetch_units] No unit task links found. Check login / URL.")
        return 1

    print(f"[fetch_units] Found {len(unit_task_links)} unit(s).")
    total_tasks = 0

    for unit_tasks_url in unit_task_links:
        unit_id = unit_tasks_url.rstrip("/").split("/")[-2]
        unit_page = _cached_get(client, unit_tasks_url, CACHE_DIR / "units" / f"{unit_id}.html", refresh)

        bc = _breadcrumb(unit_page)
        unit_title = bc[1] if len(bc) > 1 else ""
        unit_slug = _unit_slug_from_url(unit_tasks_url, unit_title)

        print(f"\n[unit] {unit_title or unit_id} -> units/{unit_slug}/")

        # Extract unit intro from the tasks-list page (no separate detail page exists)
        intro_content = _html_to_md(_main_content(unit_page))
        if intro_content:
            intro_path = UNITS_DIR / unit_slug / "unit-intro.md"
            intro_path.parent.mkdir(parents=True, exist_ok=True)
            intro_path.write_text(f"# {unit_title}\n\n{intro_content}\n", encoding="utf-8")
            print(f"  [intro] -> {intro_path.relative_to(REPO_ROOT)}")

        # Find task links: /units/<uuid>/tasks/<uuid>/
        task_links = list(dict.fromkeys(
            urljoin(BASE_URL, href)
            for href, _ in _parse_links(unit_page)
            if re.search(r"/units/[0-9a-f-]+/tasks/[0-9a-f-]+/?$", href)
        ))

        for task_url in task_links:
            parts = task_url.rstrip("/").split("/")
            task_id = parts[-1]
            task_page = _cached_get(
                client, task_url,
                CACHE_DIR / "tasks" / f"{unit_id}__{task_id}.html",
                refresh,
            )

            tbc = _breadcrumb(task_page)
            task_title = tbc[2] if len(tbc) > 2 else ""
            task_slug = _task_slug_from_url(task_url, task_title)

            task_dir = UNITS_DIR / unit_slug / task_slug
            task_dir.mkdir(parents=True, exist_ok=True)
            print(f"  [task] {task_title or task_id} -> {task_dir.relative_to(REPO_ROOT)}/")

            # Write prompt.md
            prompt_md = _html_to_md(_main_content(task_page))
            prompt_path = task_dir / "prompt.md"
            prompt_path.write_text(
                f"# {task_title}\n\nSource: {task_url}\n\n{prompt_md}\n",
                encoding="utf-8",
            )
            print(f"    [prompt] -> {prompt_path.relative_to(REPO_ROOT)}")

            # Write task metadata
            meta = {
                "unit": unit_title,
                "unit_slug": unit_slug,
                "task": task_title,
                "task_slug": task_slug,
                "url": task_url,
            }
            (task_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

            if fetch_data:
                # Find download links
                download_urls = sorted(set(
                    href
                    for href, _ in _parse_links(task_page)
                    if "download.smartlab" in href
                    or re.search(r"\.(zip|gz|csv|json)(\?|$)", href, re.I)
                ))
                if download_urls:
                    _download_data(client, download_urls, task_dir / "data")
                else:
                    print("    [data] no download links found on task page")

            total_tasks += 1

    print(f"\n[fetch_units] Done. {total_tasks} task(s) written to {UNITS_DIR.relative_to(REPO_ROOT)}/")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="re-fetch pages (ignore cache)")
    parser.add_argument("--insecure", action="store_true", help="skip TLS certificate verification")
    parser.add_argument("--no-data", action="store_true", help="skip downloading data files")
    args = parser.parse_args()
    return fetch_all(refresh=args.refresh, insecure=args.insecure, fetch_data=not args.no_data)


if __name__ == "__main__":
    raise SystemExit(main())
