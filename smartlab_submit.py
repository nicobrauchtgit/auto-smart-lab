#!/usr/bin/env python3
"""One-stop SmartLab submission command.

The upload endpoint only returns a short success/error message. The official
score/result is rendered in the task page Attempts table, so this script uploads
`output.csv` + source archive, re-fetches/polls the task page, and returns a
compact JSON signal: upload status/message, error/format_error, numeric try
counts, current_score, previous_scores, and improved.

Examples:
  # Check current attempts/results without uploading
  python3 smartlab_submit.py status TASK_URL --insecure

  # Upload and directly receive machine-readable score feedback
  python3 smartlab_submit.py upload TASK_URL submissions/spam1_predictions.csv \
    --source-dir . --comment "auto-agent attempt" --insecure --json
"""
from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
import argparse
import json

from fetch_lab import LabClient
from smartlab.submit import Attempt, SubmissionResult, get_task_info, submit_and_score


def format_attempt(attempt: Attempt) -> str:
    return (
        f"#{attempt.number} | {attempt.date} | "
        f"result={attempt.result or '<pending>'} | info={attempt.info or '<none>'} | "
        f"comment={attempt.comment or '<none>'}"
    )


def print_task_info(info, *, json_output: bool = False) -> None:
    if json_output:
        print(json.dumps({
            "title": info.title,
            "task_url": info.task_url,
            "upload_url": info.upload_url,
            "attempts_used": info.attempts_used,
            "attempts": [asdict(attempt) for attempt in info.attempts],
        }, indent=2))
        return

    print(f"Task: {info.title}")
    print(f"URL: {info.task_url}")
    print(f"Upload URL: {info.upload_url or '<none>'}")
    print(f"Attempts used: {info.attempts_used or '<unknown>'}")
    if info.attempts:
        print("Attempts:")
        for attempt in info.attempts:
            print(f"  {format_attempt(attempt)}")
    else:
        print("Attempts: none")


def print_submission_result(result: SubmissionResult, *, json_output: bool = False) -> None:
    if json_output:
        print(json.dumps(asdict(result), indent=2))
        return

    print(f"ok: {result.ok}")
    print(f"upload_ok: {result.upload_ok}")
    print(f"upload_status: {result.upload_status}")
    print(f"upload_message: {result.upload_message or '<none>'}")
    print(f"error: {result.error or '<none>'}")
    print(f"format_error: {result.format_error or '<none>'}")
    print(f"tries: {result.tries_used}/{result.max_tries} used, {result.tries_left} left")
    print(f"current_score: {result.current_score if result.current_score is not None else '<none>'}")
    print(f"previous_scores: {result.previous_scores}")
    print(f"improved: {result.improved}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--insecure", action="store_true", help="accept the lab's self-signed TLS certificate")
    common.add_argument("--json", action="store_true", help="print machine-readable JSON")
    sub = parser.add_subparsers(dest="command", required=True)

    status = sub.add_parser("status", parents=[common], help="fetch task page and parse attempts table")
    status.add_argument("task_url")

    upload = sub.add_parser("upload", parents=[common], help="upload output.csv + source archive, then return parsed score")
    upload.add_argument("task_url")
    upload.add_argument("output_csv", type=Path, help="prediction file; uploaded with filename output.csv")
    upload.add_argument("--source-dir", type=Path, default=Path("."), help="source directory to zip; default: current dir")
    upload.add_argument("--archive", type=Path, default=None, help="prebuilt source archive; overrides --source-dir zipping")
    upload.add_argument("--comment", default="auto-agent submission", help="attempt comment if accepted by server")
    upload.add_argument("--poll-timeout", type=int, default=180, help="seconds to poll for result after upload")
    upload.add_argument("--poll-interval", type=int, default=10, help="seconds between task-page polls")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    client = LabClient(insecure_tls=args.insecure)

    if args.command == "status":
        info = get_task_info(client, args.task_url)
        print_task_info(info, json_output=args.json)
        return 0

    if args.command == "upload":
        if not args.json:
            print(f"Uploading {args.output_csv} as output.csv ...")
        result = submit_and_score(
            args.task_url,
            args.output_csv,
            args.source_dir,
            client=client,
            comment=args.comment,
            archive_path=args.archive,
            poll_timeout_s=args.poll_timeout,
            poll_interval_s=args.poll_interval,
        )
        print_submission_result(result, json_output=args.json)
        # Keep exit code 0 for server-side validation failures: the agent needs
        # to observe `ok=false` / `format_error=...` as feedback rather than
        # losing the result to a shell error.
        return 0

    raise SystemExit(f"unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
