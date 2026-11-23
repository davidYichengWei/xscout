#!/usr/bin/env python3
"""xscout result delivery (runs on the Grok Bot cloud computer).

Usage: python3 deliver.py <request_json_file> <result_json_file>
  request_json_file: the webhook payload, saved exactly as received
  result_json_file:  the result JSON built by the routine

Delivery "ntfy": encrypts the result with the per-run key from the payload and publishes it to
{{NTFY_SERVER}}. No secret is needed. Delivery "github" (only if a repo is configured below): commits
the result to that repo and needs env XSCOUT_GITHUB_TOKEN. Standard library only.
"""
import base64
import hashlib
import hmac
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
import zlib

NTFY_SERVER = "{{NTFY_SERVER}}"
REPO = "{{REPO}}"
BRANCH = "{{BRANCH}}"
RESULTS_DIR = "{{RESULTS_DIR}}"
GITHUB_API = os.environ.get("XSCOUT_GITHUB_API", "https://api.github.com").rstrip("/")
RUN_ID_RE = r"xs-\d{8}-\d{6}-[0-9a-f]{6}"


def fail(msg):
    print(f"XSCOUT_DELIVERY_FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def load_json(path, what):
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
        return raw, json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        fail(f"{what} {path} is not valid JSON: {exc}")


def seal(plaintext, key, run_id):
    """Encrypt-then-MAC from HMAC-SHA256; must match src/seal.ts byte for byte."""
    enc = hmac.new(key, b"xscout-enc", hashlib.sha256).digest()
    mac = hmac.new(key, b"xscout-mac", hashlib.sha256).digest()
    nonce = os.urandom(16)
    data = zlib.compress(plaintext, 9)
    stream = bytearray()
    counter = 0
    while len(stream) < len(data):
        stream += hmac.new(enc, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest()
        counter += 1
    ciphertext = bytes(a ^ b for a, b in zip(data, stream))
    tag = hmac.new(mac, b"xscout-v1\0" + run_id.encode() + b"\0" + nonce + ciphertext, hashlib.sha256).digest()
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return json.dumps({"xscout_sealed": 1, "run_id": run_id, "nonce": b64(nonce), "ciphertext": b64(ciphertext), "tag": b64(tag)}).encode()


def with_retries(what, attempt_once):
    for attempt in range(1, 6):
        try:
            return attempt_once()
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:300].decode(errors="replace")
            if exc.code in (400, 401, 403, 404, 413):
                fail(f"{what}: HTTP {exc.code} {detail}")
            print(f"attempt {attempt}: {what}: HTTP {exc.code} {detail}", file=sys.stderr)
        except urllib.error.URLError as exc:
            print(f"attempt {attempt}: {what}: network error {exc}", file=sys.stderr)
        time.sleep(min(20, 2 ** attempt) + random.random())
    fail(f"{what}: gave up after 5 attempts")


def deliver_ntfy(run_id, delivery, raw):
    url = str(delivery.get("url", ""))
    if not re.fullmatch(re.escape(NTFY_SERVER) + r"/xs_[A-Za-z0-9_-]{24}", url):
        fail(f"delivery.url must be {NTFY_SERVER}/xs_<24 characters>, got {url!r}")
    key_text = str(delivery.get("key", ""))
    try:
        key = base64.urlsafe_b64decode(key_text + "=" * (-len(key_text) % 4))
    except Exception:  # noqa: BLE001
        key = b""
    if len(key) != 32:
        fail("delivery.key must be the 43-character key from the payload, copied exactly")
    body = seal(raw, key, run_id)

    def put():
        req = urllib.request.Request(
            url,
            data=body,
            method="PUT",
            headers={"Filename": f"{run_id}.json", "Title": f"xscout {run_id}", "User-Agent": "xscout-routine"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status

    status = with_retries("ntfy publish", put)
    print(f"XSCOUT_DELIVERED {run_id} (ntfy HTTP {status})")


def deliver_github(run_id, delivery, raw):
    if not REPO:
        fail("GitHub delivery is not enabled for this routine; ask for ntfy delivery instead")
    path = str(delivery.get("path", ""))
    expected = f"{RESULTS_DIR}/{run_id[3:7]}-{run_id[7:9]}-{run_id[9:11]}/{run_id}.json"
    if path != expected:
        fail(f"delivery.path must be {expected}")
    token = os.environ.get("XSCOUT_GITHUB_TOKEN", "").strip()
    if not token:
        fail("environment variable XSCOUT_GITHUB_TOKEN is not set (load it from your secure vault)")
    url = f"{GITHUB_API}/repos/{REPO}/contents/{path}"
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

    def put():
        sha = None
        try:
            _, meta = call("GET", f"{url}?ref={BRANCH}")
            sha = meta.get("sha")
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                fail(f"GitHub rejected the token (HTTP {exc.code}); check XSCOUT_GITHUB_TOKEN")
        body = {"message": f"xscout: {run_id}", "content": base64.b64encode(raw).decode(), "branch": BRANCH}
        if sha:
            body["sha"] = sha
        return call("PUT", url, body)[0]  # 409/422 means a concurrent commit: retried

    status = with_retries(f"GitHub commit to {REPO}", put)
    print(f"XSCOUT_DELIVERED {run_id} (GitHub HTTP {status})")


def main():
    if len(sys.argv) != 3:
        fail("usage: deliver.py <request_json_file> <result_json_file>")
    _, request = load_json(sys.argv[1], "request file")
    raw, result = load_json(sys.argv[2], "result file")
    run_id = str(request.get("run_id", ""))
    if request.get("xscout") != 1 or not re.fullmatch(RUN_ID_RE, run_id):
        fail("request file must be the xscout webhook payload with a valid run_id")
    if result.get("xscout_result") != 1 or result.get("run_id") != run_id or result.get("status") not in ("ok", "error"):
        fail('result JSON must contain "xscout_result": 1, the matching "run_id" and "status": "ok"|"error"')
    delivery = request.get("delivery") or {}
    kind = delivery.get("type")
    if kind == "ntfy":
        deliver_ntfy(run_id, delivery, raw)
    elif kind == "github":
        deliver_github(run_id, delivery, raw)
    else:
        fail(f"unknown delivery.type {kind!r}")


if __name__ == "__main__":
    main()
