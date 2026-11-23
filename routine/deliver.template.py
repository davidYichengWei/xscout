#!/usr/bin/env python3
"""xscout result delivery (runs on the Grok Bot cloud computer).

Usage: python3 deliver.py <run_id> <result_path> <result_json_file>
Needs env XSCOUT_GITHUB_TOKEN (fine-grained token: Contents read/write on {{REPO}} only).
Standard library only.
"""
import base64
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request

REPO = "{{REPO}}"
BRANCH = "{{BRANCH}}"
RESULTS_DIR = "{{RESULTS_DIR}}"
API = os.environ.get("XSCOUT_GITHUB_API", "https://api.github.com").rstrip("/")


def fail(msg):
    print(f"XSCOUT_DELIVERY_FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def main():
    if len(sys.argv) != 4:
        fail("usage: deliver.py <run_id> <result_path> <result_json_file>")
    run_id, path, file = sys.argv[1:]
    if not re.fullmatch(r"xs-\d{8}-\d{6}-[0-9a-f]{6}", run_id):
        fail(f"bad run_id {run_id!r}")
    expected = f"{RESULTS_DIR}/{run_id[3:7]}-{run_id[7:9]}-{run_id[9:11]}/{run_id}.json"
    if path != expected:
        fail(f"result_path must be {expected}")
    token = os.environ.get("XSCOUT_GITHUB_TOKEN", "").strip()
    if not token:
        fail("environment variable XSCOUT_GITHUB_TOKEN is not set (load it from your secure vault)")
    with open(file, "rb") as fh:
        raw = fh.read()
    try:
        data = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        fail(f"result file is not valid JSON: {exc}")
    if data.get("xscout_result") != 1 or data.get("run_id") != run_id or data.get("status") not in ("ok", "error"):
        fail('result JSON must contain "xscout_result": 1, the matching "run_id" and "status": "ok"|"error"')

    url = f"{API}/repos/{REPO}/contents/{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "xscout-routine",
        "Content-Type": "application/json",
    }

    def call(method, target, body=None):
        payload = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(target, data=payload, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read()
            return resp.status, (json.loads(text) if text else {})

    for attempt in range(1, 6):
        sha = None
        try:
            _, meta = call("GET", f"{url}?ref={BRANCH}")
            sha = meta.get("sha")
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                fail(f"GitHub rejected the token (HTTP {exc.code}); check XSCOUT_GITHUB_TOKEN")
        except urllib.error.URLError as exc:
            print(f"attempt {attempt}: network error {exc}", file=sys.stderr)
        body = {"message": f"xscout: {run_id}", "content": base64.b64encode(raw).decode(), "branch": BRANCH}
        if sha:
            body["sha"] = sha
        try:
            status, _ = call("PUT", url, body)
            print(f"XSCOUT_DELIVERED {run_id} (HTTP {status})")
            return
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:300].decode(errors="replace")
            if exc.code in (401, 403, 404):
                fail(f"GitHub HTTP {exc.code}: {detail} (token needs Contents read/write on {REPO})")
            print(f"attempt {attempt}: HTTP {exc.code} {detail}", file=sys.stderr)  # 409/422: concurrent commit, retry
        except urllib.error.URLError as exc:
            print(f"attempt {attempt}: network error {exc}", file=sys.stderr)
        time.sleep(min(20, 2 ** attempt) + random.random())
    fail("gave up after 5 attempts")


if __name__ == "__main__":
    main()
