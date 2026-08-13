"""Submission helpers for SmartLab task pages."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Iterable
from urllib.error import HTTPError
from urllib.parse import urljoin
from urllib.request import Request
import html
import mimetypes
import random
import re
import string
import time
import zipfile

from fetch_lab import BASE_URL, LabClient


@dataclass
class Attempt:
    number: str
    date: str
    comment: str
    result: str
    info: str


@dataclass
class TaskPageInfo:
    title: str
    task_url: str
    upload_url: str | None
    csrf_token: str | None
    attempts_used: str | None
    attempts: list[Attempt]


@dataclass
class SubmissionResult:
    ok: bool
    upload_ok: bool
    upload_status: int | None
    upload_message: str | None
    error: str | None
    format_error: str | None
    max_tries: int
    tries_used: int | None
    tries_left: int | None
    current_score: float | None
    previous_scores: list[float]
    improved: bool


def clean_html(fragment: str) -> str:
    text = re.sub(r"<script.*?</script>", " ", fragment, flags=re.I | re.S)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    return html.unescape(re.sub(r"\s+", " ", text).strip())


def parse_score(value: str | None) -> float | None:
    """Parse a numeric score from the Attempts table.

    SmartLab uses strings such as ``0.991``, ``0.0`` or ``---``.  Failures and
    pending rows intentionally return None so the optimizer does not treat them
    as real scores.
    """
    if not value:
        return None
    value = clean_html(value)
    if value in {"---", "-", ""}:
        return None
    match = re.search(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", value)
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def scores(attempts: list[Attempt]) -> list[float]:
    return [score for attempt in attempts if (score := parse_score(attempt.result)) is not None]


def best_score(attempts: list[Attempt]) -> float | None:
    values = scores(attempts)
    if not values:
        return None
    return max(values)


def parse_tries_used(value: str | None) -> int | None:
    if not value:
        return None
    match = re.search(r"(\d+)\s+of\s+\d+\s+attempts\s+used", value, flags=re.I)
    if not match:
        return None
    return int(match.group(1))


def parse_task_page(task_url: str, page: str) -> TaskPageInfo:
    title_match = re.search(r"<h1[^>]*>(.*?)</h1>", page, flags=re.I | re.S)
    title = clean_html(title_match.group(1)) if title_match else task_url

    form_match = re.search(
        r'<form[^>]+action="([^"]+/upload/)"[^>]*enctype="multipart/form-data"[^>]*>(.*?)</form>',
        page,
        flags=re.I | re.S,
    )
    upload_url = None
    csrf_token = None
    if form_match:
        upload_url = urljoin(BASE_URL, html.unescape(form_match.group(1)))
        csrf_match = re.search(
            r'<input[^>]+name="csrfmiddlewaretoken"[^>]+value="([^"]+)"',
            form_match.group(2),
            flags=re.I | re.S,
        )
        if csrf_match:
            csrf_token = html.unescape(csrf_match.group(1))

    attempts_used = None
    used_match = re.search(r"(\d+\s+of\s+\d+\s+attempts\s+used)", page, flags=re.I)
    if used_match:
        attempts_used = used_match.group(1)

    attempts: list[Attempt] = []
    for row in re.findall(r"<tr>(.*?)</tr>", page, flags=re.I | re.S):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, flags=re.I | re.S)
        if len(cells) >= 5 and "currently no valid attempts" not in clean_html(row).lower():
            attempts.append(
                Attempt(
                    number=clean_html(cells[0]),
                    date=clean_html(cells[1]),
                    comment=clean_html(cells[2]),
                    result=clean_html(cells[3]),
                    info=clean_html(cells[4]),
                )
            )
    return TaskPageInfo(
        title=title,
        task_url=task_url,
        upload_url=upload_url,
        csrf_token=csrf_token,
        attempts_used=attempts_used,
        attempts=attempts,
    )


def make_source_archive(source_dir: Path, archive_path: Path) -> Path:
    """Create a small source archive suitable for SmartLab upload.

    Excludes data, cached HTML pages, cookies, generated submissions, reports,
    virtualenvs, and Python caches so the archive stays below the 2 MB upload
    limit used by the web UI.
    """
    source_dir = source_dir.resolve()
    archive_path.parent.mkdir(parents=True, exist_ok=True)

    excluded_dirs = {
        ".git",
        "__pycache__",
        ".pytest_cache",
        "env",
        "venv",
        ".venv",
        "data",
        "downloaded_task_page",
        "submissions",
        "reports",
    }
    excluded_names = {
        "lab-cookies.txt",
        "source.zip",
        "output.csv",
    }
    allowed_suffixes = {
        ".py",
        ".sh",
        ".md",
        ".txt",
        ".toml",
        ".yaml",
        ".yml",
        ".json",
    }

    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(source_dir.rglob("*")):
            rel = path.relative_to(source_dir)
            if any(part in excluded_dirs for part in rel.parts):
                continue
            if path.name in excluded_names or path.name.startswith("._"):
                continue
            if path.is_dir():
                continue
            if path.suffix.lower() not in allowed_suffixes:
                continue
            zf.write(path, Path("source") / rel)
    return archive_path


def build_multipart(fields: dict[str, str], files: Iterable[tuple[str, str, Path]]) -> tuple[bytes, str]:
    boundary = "----smartlab" + "".join(random.choice(string.ascii_letters + string.digits) for _ in range(24))
    chunks: list[bytes] = []

    def add(line: str | bytes = b"") -> None:
        if isinstance(line, str):
            line = line.encode("utf-8")
        chunks.append(line + b"\r\n")

    for name, value in fields.items():
        add(f"--{boundary}")
        add(f'Content-Disposition: form-data; name="{name}"')
        add()
        add(value)

    for field_name, upload_filename, path in files:
        content_type = mimetypes.guess_type(upload_filename)[0] or "application/octet-stream"
        add(f"--{boundary}")
        add(
            f'Content-Disposition: form-data; name="{field_name}"; '
            f'filename="{upload_filename}"'
        )
        add(f"Content-Type: {content_type}")
        add()
        chunks.append(path.read_bytes())
        chunks.append(b"\r\n")

    add(f"--{boundary}--")
    return b"".join(chunks), boundary


def post_multipart(
    client: LabClient,
    url: str,
    fields: dict[str, str],
    files: Iterable[tuple[str, str, Path]],
    referer: str,
    csrf_token: str | None,
):
    body, boundary = build_multipart(fields, files)
    headers = {
        "User-Agent": "Mozilla/5.0 smartlab-auto-agent/0.1",
        "Accept": "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(len(body)),
        "Referer": referer,
        # The website uses Dropzone/XHR for uploads. This is not strictly
        # required by every task, but matching the browser request avoids
        # server-side upload handling differences.
        "X-Requested-With": "XMLHttpRequest",
    }
    if csrf_token:
        headers["X-CSRFToken"] = csrf_token
    req = Request(url, data=body, headers=headers, method="POST")
    from fetch_lab import Response

    try:
        with client.opener.open(req, timeout=180) as response:
            return Response(
                url=response.geturl(),
                status=response.status,
                headers=response.headers,
                body=response.read(),
            )
    except HTTPError as exc:
        return Response(
            url=exc.geturl(),
            status=exc.code,
            headers=exc.headers,
            body=exc.read(),
        )


def get_task_info(client: LabClient, task_url: str) -> TaskPageInfo:
    response = client.get(task_url)
    return parse_task_page(response.url, response.text)


def submit_attempt(
    task_url: str,
    output_csv: Path,
    source_dir: Path,
    *,
    client: LabClient,
    comment: str = "",
    archive_path: Path | None = None,
) -> TaskPageInfo:
    output_csv = output_csv.resolve()
    if not output_csv.exists():
        raise FileNotFoundError(output_csv)

    info = get_task_info(client, task_url)
    if not info.upload_url:
        raise RuntimeError(f"Task page does not expose an upload form: {task_url}")
    if not info.csrf_token:
        raise RuntimeError("Could not find upload CSRF token")

    with TemporaryDirectory() as tmpdir:
        if archive_path is None:
            archive_path = Path(tmpdir) / "source.zip"
            make_source_archive(source_dir, archive_path)
        else:
            archive_path = archive_path.resolve()

        if archive_path.stat().st_size > 2 * 1024 * 1024:
            raise RuntimeError(f"Source archive exceeds 2 MB upload limit: {archive_path}")
        if output_csv.stat().st_size > 2 * 1024 * 1024:
            raise RuntimeError(f"output.csv exceeds 2 MB upload limit: {output_csv}")

        response = post_multipart(
            client,
            info.upload_url,
            fields={"csrfmiddlewaretoken": info.csrf_token, "comment": comment},
            files=[
                # Dropzone with uploadMultiple=true sends file[0], file[1],
                # not repeated plain "file" fields. The server accepts this
                # shape; repeated "file" fields returned "File upload error".
                ("file[0]", "output.csv", output_csv),
                ("file[1]", "source.zip", archive_path),
            ],
            referer=info.task_url,
            csrf_token=info.csrf_token,
        )
        if response.status >= 400:
            raise RuntimeError(f"Upload failed with HTTP {response.status}: {response.text[:500]}")
        client.save_cookies()

    return get_task_info(client, task_url)


def poll_for_result(client: LabClient, task_url: str, attempts_before: int, timeout_s: int = 180, interval_s: int = 10) -> TaskPageInfo:
    deadline = time.time() + timeout_s
    last_info = get_task_info(client, task_url)
    while time.time() < deadline:
        attempts = last_info.attempts
        has_new_attempt = len(attempts) > attempts_before
        has_result = has_new_attempt and bool(attempts[0].result)
        if has_result:
            return last_info
        time.sleep(interval_s)
        last_info = get_task_info(client, task_url)
    return last_info


def attempt_key(attempt: Attempt) -> tuple[str, str, str, str, str]:
    return (attempt.number, attempt.date, attempt.comment, attempt.result, attempt.info)


def find_new_attempt(before: TaskPageInfo, after: TaskPageInfo) -> Attempt | None:
    before_keys = {attempt_key(attempt) for attempt in before.attempts}
    for attempt in after.attempts:
        if attempt_key(attempt) not in before_keys:
            return attempt
    return None


def submit_and_score(
    task_url: str,
    output_csv: Path,
    source_dir: Path,
    *,
    client: LabClient,
    comment: str = "",
    archive_path: Path | None = None,
    poll_timeout_s: int = 180,
    poll_interval_s: int = 10,
) -> SubmissionResult:
    """Upload a submission and return a compact score signal.

    The upload endpoint only reports upload success/failure.  Scores and CSV
    formatting errors are read afterwards from the rendered Attempts table.
    """
    max_tries = 3
    before = get_task_info(client, task_url)
    previous_scores = scores(before.attempts)
    previous_best = max(previous_scores) if previous_scores else None

    def result(
        *,
        ok: bool,
        upload_ok: bool,
        upload_status: int | None = None,
        upload_message: str | None = None,
        error: str | None = None,
        format_error: str | None = None,
        attempts_info: TaskPageInfo | None = None,
        current_score: float | None = None,
        improved: bool = False,
    ) -> SubmissionResult:
        info = attempts_info or before
        tries_used = parse_tries_used(info.attempts_used)
        return SubmissionResult(
            ok=ok,
            upload_ok=upload_ok,
            upload_status=upload_status,
            upload_message=upload_message,
            error=error,
            format_error=format_error,
            max_tries=max_tries,
            tries_used=tries_used,
            tries_left=(max_tries - tries_used) if tries_used is not None else None,
            current_score=current_score,
            previous_scores=previous_scores,
            improved=improved,
        )

    output_csv = output_csv.resolve()
    if not output_csv.exists():
        return result(ok=False, upload_ok=False, error=f"output.csv not found: {output_csv}")
    if not before.upload_url:
        return result(ok=False, upload_ok=False, error=f"Task page does not expose an upload form: {task_url}")
    if not before.csrf_token:
        return result(ok=False, upload_ok=False, error="Could not find upload CSRF token")

    with TemporaryDirectory() as tmpdir:
        if archive_path is None:
            archive_path = Path(tmpdir) / "source.zip"
            make_source_archive(source_dir, archive_path)
        else:
            archive_path = archive_path.resolve()

        if archive_path.stat().st_size > 2 * 1024 * 1024:
            return result(ok=False, upload_ok=False, error=f"Source archive exceeds 2 MB upload limit: {archive_path}")
        if output_csv.stat().st_size > 2 * 1024 * 1024:
            return result(ok=False, upload_ok=False, error=f"output.csv exceeds 2 MB upload limit: {output_csv}")

        response = post_multipart(
            client,
            before.upload_url,
            fields={"csrfmiddlewaretoken": before.csrf_token, "comment": comment},
            files=[
                ("file[0]", "output.csv", output_csv),
                ("file[1]", "source.zip", archive_path),
            ],
            referer=before.task_url,
            csrf_token=before.csrf_token,
        )
        upload_message = clean_html(response.text)
        upload_ok = 200 <= response.status < 300 and "successfully" in upload_message.lower()
        if not upload_ok:
            return result(
                ok=False,
                upload_ok=False,
                upload_status=response.status,
                upload_message=upload_message,
                error=upload_message or f"Upload failed with HTTP {response.status}",
            )
        client.save_cookies()

    after = poll_for_result(
        client,
        task_url,
        attempts_before=len(before.attempts),
        timeout_s=poll_timeout_s,
        interval_s=poll_interval_s,
    )
    new_attempt = find_new_attempt(before, after)
    if new_attempt is None:
        return result(
            ok=False,
            upload_ok=True,
            upload_status=200,
            upload_message=upload_message,
            error="Upload succeeded, but no new attempt row appeared before timeout",
            attempts_info=after,
        )

    current_score = parse_score(new_attempt.result)
    format_error = new_attempt.comment if new_attempt.info.upper() == "FAILURE" else None
    if current_score is None:
        return result(
            ok=False,
            upload_ok=True,
            upload_status=200,
            upload_message=upload_message,
            error="No numeric score returned",
            format_error=format_error,
            attempts_info=after,
            current_score=None,
            improved=False,
        )

    improved = previous_best is None or current_score > previous_best
    return result(
        ok=True,
        upload_ok=True,
        upload_status=200,
        upload_message=upload_message,
        attempts_info=after,
        current_score=current_score,
        improved=improved,
    )
