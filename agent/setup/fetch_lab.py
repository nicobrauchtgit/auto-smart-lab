#!/usr/bin/env python3
"""Login/fetch helper for the SmartLab lab web UI.

This is intentionally stdlib-only: no requests/bs4 dependency is required.
It stores cookies in Netscape/Mozilla format, so the resulting cookie file can
also be passed to wget via `--load-cookies`.

Environment:
  LAB_BASE_URL      default: https://lab-test.smartlab.mlsec.tu-berlin.de/
  LAB_LOGIN_URL     optional explicit login URL, defaults to LAB_BASE_URL
  LAB_COOKIE_FILE   default: lab-cookies.txt
  LAB_USER          username for login
  LAB_PASS          password for login
  LAB_INSECURE_TLS  set to 1/true/yes to accept the lab's self-signed cert
  LAB_CA_BUNDLE     optional CA bundle path, preferred over LAB_INSECURE_TLS
"""
from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
from http.cookiejar import MozillaCookieJar
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode, urljoin, urlparse
from urllib.request import (
    HTTPCookieProcessor,
    HTTPSHandler,
    Request,
    build_opener,
)
import argparse
import os
import ssl
import sys

BASE_URL = os.environ.get("LAB_BASE_URL", "https://lab-test.smartlab.mlsec.tu-berlin.de/")
LOGIN_URL = os.environ.get("LAB_LOGIN_URL", BASE_URL)
COOKIE_FILE = Path(os.environ.get("LAB_COOKIE_FILE", "lab-cookies.txt"))


@dataclass
class Response:
    url: str
    status: int
    headers: Any
    body: bytes

    @property
    def text(self) -> str:
        charset = self.headers.get_content_charset() or "utf-8"
        return self.body.decode(charset, errors="replace")


class FormParser(HTMLParser):
    """Small form parser sufficient for login forms and CSRF fields."""

    def __init__(self) -> None:
        super().__init__()
        self.forms: list[dict[str, Any]] = []
        self._current: dict[str, Any] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = {k.lower(): (v if v is not None else "") for k, v in attrs}
        tag = tag.lower()
        if tag == "form":
            self._current = {
                "action": attr.get("action", ""),
                "method": attr.get("method", "get").lower(),
                "inputs": [],
            }
        elif tag == "input" and self._current is not None:
            self._current["inputs"].append(attr)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "form" and self._current is not None:
            self.forms.append(self._current)
            self._current = None


def truthy(value: str | None) -> bool:
    return str(value or "").lower() in {"1", "true", "yes", "y", "on"}


def make_ssl_context(insecure: bool = False) -> ssl.SSLContext | None:
    ca_bundle = os.environ.get("LAB_CA_BUNDLE")
    if ca_bundle:
        return ssl.create_default_context(cafile=ca_bundle)
    if insecure or truthy(os.environ.get("LAB_INSECURE_TLS")):
        return ssl._create_unverified_context()  # noqa: SLF001 - explicit lab option
    return None


class LabClient:
    def __init__(self, insecure_tls: bool = False) -> None:
        self.cookie_file = COOKIE_FILE
        self.cookie_file.parent.mkdir(parents=True, exist_ok=True)
        self.cookies = MozillaCookieJar(str(self.cookie_file))
        if self.cookie_file.exists():
            self.cookies.load(ignore_discard=True, ignore_expires=True)

        handlers: list[Any] = [HTTPCookieProcessor(self.cookies)]
        ssl_context = make_ssl_context(insecure_tls)
        if ssl_context is not None:
            handlers.append(HTTPSHandler(context=ssl_context))
        self.opener = build_opener(*handlers)

    def save_cookies(self) -> None:
        self.cookies.save(ignore_discard=True, ignore_expires=True)

    def request(self, url: str, data: dict[str, str] | None = None, referer: str | None = None) -> Response:
        encoded_data = None if data is None else urlencode(data).encode("utf-8")
        headers = {
            "User-Agent": "Mozilla/5.0 smartlab-auto-agent/0.1",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
        if data is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        if referer:
            parsed = urlparse(referer)
            headers["Referer"] = referer
            headers["Origin"] = f"{parsed.scheme}://{parsed.netloc}"
        req = Request(url, data=encoded_data, headers=headers)
        try:
            with self.opener.open(req, timeout=120) as response:
                return Response(
                    url=response.geturl(),
                    status=response.status,
                    headers=response.headers,
                    body=response.read(),
                )
        except HTTPError as exc:
            return Response(url=exc.geturl(), status=exc.code, headers=exc.headers, body=exc.read())

    def is_login_page(self, html: str) -> bool:
        # Some task pages legitimately contain the words "password" and CSRF
        # fields (for forms/logout), so detect the actual login form instead
        # of relying on broad substring matches.
        try:
            forms = self.parse_forms(html)
        except Exception:
            forms = []
        for form in forms:
            has_password = any(
                field.get("type", "text").lower() == "password"
                for field in form.get("inputs", [])
            )
            has_user = any(
                "user" in str(field.get("name", "")).lower()
                or "login" in str(field.get("name", "")).lower()
                for field in form.get("inputs", [])
            )
            if has_password and has_user:
                return True
        return False

    def parse_forms(self, html: str) -> list[dict[str, Any]]:
        parser = FormParser()
        parser.feed(html)
        return parser.forms

    def csrf_from_html_or_cookie(self, html: str) -> str:
        for form in self.parse_forms(html):
            for field in form["inputs"]:
                if field.get("name") == "csrfmiddlewaretoken" and field.get("value"):
                    return str(field["value"])
        for cookie in self.cookies:
            if cookie.name == "csrftoken" and cookie.value:
                return str(cookie.value)
        raise RuntimeError("Could not find CSRF token in HTML or cookies")

    def find_login_form(self, html: str) -> dict[str, Any]:
        forms = self.parse_forms(html)
        for form in forms:
            if any(field.get("type", "text").lower() == "password" for field in form["inputs"]):
                return form
        if forms:
            return forms[0]
        raise RuntimeError("Could not find a login form")

    def login(self) -> Response:
        username = os.environ.get("LAB_USER")
        password = os.environ.get("LAB_PASS")
        if not username or not password:
            raise RuntimeError("Set LAB_USER and LAB_PASS before running login/fetch")

        login_page = self.request(LOGIN_URL)
        if login_page.status >= 400:
            raise RuntimeError(f"Could not load login page: HTTP {login_page.status}")

        form = self.find_login_form(login_page.text)
        action = form.get("action") or login_page.url
        action_url = urljoin(login_page.url, action)

        data: dict[str, str] = {}
        password_field = "password"
        username_field = "username"

        for field in form["inputs"]:
            name = field.get("name")
            if not name:
                continue
            field_type = field.get("type", "text").lower()
            value = str(field.get("value", ""))
            if field_type in {"hidden", "submit"}:
                data[str(name)] = value
            if field_type == "password":
                password_field = str(name)
            if field_type in {"text", "email"} and (
                "user" in str(name).lower() or "login" in str(name).lower() or username_field == "username"
            ):
                username_field = str(name)

        # Ensure Django-style CSRF is present even if the form parser missed it.
        if "csrfmiddlewaretoken" not in data:
            try:
                data["csrfmiddlewaretoken"] = self.csrf_from_html_or_cookie(login_page.text)
            except RuntimeError:
                pass

        data[username_field] = username
        data[password_field] = password

        result = self.request(action_url, data=data, referer=login_page.url)
        if result.status >= 400:
            raise RuntimeError(f"Login POST failed: HTTP {result.status}")
        if self.is_login_page(result.text):
            raise RuntimeError("Login failed or server still returned the login page")
        self.save_cookies()
        return result

    def get(self, path_or_url: str) -> Response:
        url = urljoin(BASE_URL, path_or_url)
        response = self.request(url)
        if response.status in (401, 403) or self.is_login_page(response.text):
            self.login()
            response = self.request(url)
        if response.status >= 400:
            raise RuntimeError(f"Fetch failed: HTTP {response.status} for {url}")
        self.save_cookies()
        return response

    def cookie_summary(self, show_sensitive: bool = False) -> str:
        if not list(self.cookies):
            return "No cookies stored."
        lines = []
        for cookie in self.cookies:
            value = cookie.value if show_sensitive else redact(cookie.value)
            lines.append(f"{cookie.domain}\t{cookie.name}={value}")
        return "\n".join(lines)


def redact(value: str) -> str:
    if len(value) <= 8:
        return "<redacted>"
    return f"{value[:4]}...{value[-4:]}"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fetch SmartLab pages with persistent login cookies")
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="accept self-signed/invalid TLS certificate; same as LAB_INSECURE_TLS=1",
    )
    parser.add_argument(
        "--show-sensitive",
        action="store_true",
        help="print full CSRF/cookie values instead of redacting them",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("csrf", help="fetch login page and print the CSRF token")
    sub.add_parser("login", help="login and save cookies")

    get_parser = sub.add_parser("get", help="fetch a lab path or full URL, re-login if needed")
    get_parser.add_argument("target")
    get_parser.add_argument("-o", "--output", type=Path, help="write response body to file")

    sub.add_parser("cookies", help="show stored cookie names/values, redacted by default")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    client = LabClient(insecure_tls=args.insecure)

    if args.command == "csrf":
        response = client.request(LOGIN_URL)
        response_text = response.text
        token = client.csrf_from_html_or_cookie(response_text)
        print(token if args.show_sensitive else redact(token))
        client.save_cookies()
        return 0

    if args.command == "login":
        response = client.login()
        print(f"Logged in. Final URL: {response.url}")
        print(f"Cookie file: {client.cookie_file}")
        print(client.cookie_summary(show_sensitive=args.show_sensitive))
        return 0

    if args.command == "get":
        response = client.get(args.target)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_bytes(response.body)
            print(f"Wrote {len(response.body)} bytes to {args.output}")
        else:
            sys.stdout.write(response.text)
        return 0

    if args.command == "cookies":
        print(f"Cookie file: {client.cookie_file}")
        print(client.cookie_summary(show_sensitive=args.show_sensitive))
        return 0

    raise SystemExit(f"unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
