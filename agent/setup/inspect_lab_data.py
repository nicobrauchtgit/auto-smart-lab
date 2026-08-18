#!/usr/bin/env python3
"""Inventory SmartLab units, challenges, data links, and local-service APIs.

Requires a valid `lab-cookies.txt` or LAB_USER/LAB_PASS for automatic login.
The generated report intentionally omits confidential unit activation tokens and
VM credentials; it only records challenge metadata, public download URLs, and
local REST endpoint paths mentioned in task descriptions.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urljoin
import argparse
import html
import json
import re

from fetch_lab import BASE_URL, LabClient

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "downloaded_task_page"
REPORT_PATH = ROOT / "reports" / "lab_data_inventory.md"
JSON_PATH = ROOT / "reports" / "lab_data_inventory.json"


@dataclass
class Challenge:
    unit: str
    title: str
    page_url: str
    downloads: list[str] = field(default_factory=list)
    local_service: str | None = None
    api_endpoints: list[str] = field(default_factory=list)


def clean_html(fragment: str) -> str:
    text = re.sub(r"<script.*?</script>", " ", fragment, flags=re.I | re.S)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    return html.unescape(re.sub(r"\s+", " ", text).strip())


def cache_get(client: LabClient, url: str, cache_path: Path, refresh: bool) -> str:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if cache_path.exists() and cache_path.stat().st_size > 0 and not refresh:
        return cache_path.read_text(encoding="utf-8", errors="replace")
    response = client.get(url)
    cache_path.write_bytes(response.body)
    return response.text


def parse_links(page: str) -> list[tuple[str, str]]:
    links: list[tuple[str, str]] = []
    for match in re.finditer(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', page, re.I | re.S):
        href = html.unescape(match.group(1))
        text = clean_html(match.group(2))
        links.append((href, text))
    return links


def parse_breadcrumb(page: str) -> list[str]:
    return [
        clean_html(match)
        for match in re.findall(r'<li[^>]*breadcrumb-item[^>]*>(.*?)</li>', page, re.I | re.S)
    ]


def parse_task_page(page: str, page_url: str) -> Challenge:
    breadcrumb = parse_breadcrumb(page)
    unit = breadcrumb[1] if len(breadcrumb) > 1 else "<unknown unit>"
    title = breadcrumb[2] if len(breadcrumb) > 2 else "<unknown challenge>"

    downloads = sorted(
        set(
            href
            for href, _ in parse_links(page)
            if "download.smartlab.mlsec.tu-berlin.de" in href
            or re.search(r"\.(zip|gz|pcap|csv|json)(\?|$)", href, re.I)
        )
    )

    plain = clean_html(page)
    service_match = re.search(r"https?://127\.0\.0\.1:\d+", plain)
    endpoints = sorted(set(re.findall(r"/api/[A-Za-z0-9_./?=&-]+", plain)))

    return Challenge(
        unit=unit,
        title=title,
        page_url=page_url,
        downloads=downloads,
        local_service=service_match.group(0) if service_match else None,
        api_endpoints=endpoints,
    )


def inventory(refresh: bool = False, insecure: bool = False) -> list[Challenge]:
    client = LabClient(insecure_tls=insecure)
    units_url = urljoin(BASE_URL, "/units/")
    units_page = cache_get(client, units_url, CACHE_DIR / "units.html", refresh)

    unit_task_links = list(
        dict.fromkeys(
            urljoin(BASE_URL, href)
            for href, _ in parse_links(units_page)
            if re.search(r"/units/[0-9a-f]+/tasks/$", href)
        )
    )

    challenges: list[Challenge] = []
    for unit_url in unit_task_links:
        unit_id = unit_url.rstrip("/").split("/")[-2]
        unit_page = cache_get(client, unit_url, CACHE_DIR / "units" / f"{unit_id}.html", refresh)
        task_links = list(
            dict.fromkeys(
                urljoin(BASE_URL, href)
                for href, _ in parse_links(unit_page)
                if re.search(r"/units/[0-9a-f]+/tasks/[0-9a-f]+/$", href)
            )
        )
        for task_url in task_links:
            parts = task_url.rstrip("/").split("/")
            task_id = parts[-1]
            task_page = cache_get(
                client,
                task_url,
                CACHE_DIR / "tasks" / f"{unit_id}__{task_id}.html",
                refresh,
            )
            challenges.append(parse_task_page(task_page, task_url))
    return challenges


def write_reports(challenges: list[Challenge]) -> None:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    JSON_PATH.write_text(
        json.dumps([challenge.__dict__ for challenge in challenges], indent=2),
        encoding="utf-8",
    )

    lines = [
        "# SmartLab data inventory",
        "",
        "This inventory intentionally omits credentials, session cookies, VM passwords, and unit activation tokens.",
        "",
    ]
    current_unit = None
    for challenge in challenges:
        if challenge.unit != current_unit:
            current_unit = challenge.unit
            lines.extend([f"## {current_unit}", ""])
        lines.append(f"### {challenge.title}")
        lines.append(f"- Page: `{challenge.page_url}`")
        if challenge.downloads:
            lines.append("- Downloads:")
            for url in challenge.downloads:
                lines.append(f"  - `{url}`")
        if challenge.local_service:
            lines.append(f"- Local service: `{challenge.local_service}`")
        if challenge.api_endpoints:
            lines.append("- API endpoints:")
            for endpoint in challenge.api_endpoints:
                # Avoid copying placeholder/token query values into the report.
                endpoint = re.sub(r"token=[^&\s]+", "token=<unit-token>", endpoint)
                lines.append(f"  - `{endpoint}`")
        if not challenge.downloads and not challenge.local_service and not challenge.api_endpoints:
            lines.append("- Data/API: not listed on the task page")
        lines.append("")
    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="re-fetch pages instead of using cache")
    parser.add_argument("--insecure", action="store_true", help="accept the lab's self-signed certificate")
    args = parser.parse_args()

    challenges = inventory(refresh=args.refresh, insecure=args.insecure)
    write_reports(challenges)
    print(f"Challenges: {len(challenges)}")
    print(f"Markdown: {REPORT_PATH}")
    print(f"JSON: {JSON_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
