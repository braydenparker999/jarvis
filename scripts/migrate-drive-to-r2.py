#!/usr/bin/env python3
"""Clone the public Google Drive music library into Cloudflare R2.

Designed for resumable GitHub Actions runs. Object keys are immutable/content-versioned:
  audio/<drive-file-id>/<md5-or-revision-hash>.<extension>

A rerun HEAD-checks R2 and skips verified objects. The canonical mapping is only
published after a complete full-library run succeeds.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import mimetypes
import os
import random
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

DRIVE_ROOT = "https://www.googleapis.com/drive/v3/files"
AUDIO_RE = re.compile(r"\.(mp3|m4a|m4b|aac|flac|wav|wave|ogg|oga|opus|weba|webm|mp4|aif|aiff|wma|mka)$", re.I)
ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,200}$")
EXT_RE = re.compile(r"^[a-z0-9]{1,8}$")
RETRYABLE = {408, 429, 500, 502, 503, 504}
LOG_LOCK = threading.Lock()


def log(message: str) -> None:
    with LOG_LOCK:
        print(message, flush=True)


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def drive_request(path: str, params: dict[str, str], api_key: str, *, raw: bool = False):
    query = urllib.parse.urlencode({**params, "key": api_key})
    url = f"{DRIVE_ROOT}{path}?{query}"
    last = None
    for attempt in range(6):
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": "jarvis-r2-migrator/1.0", "Accept": "*/*"},
            )
            response = urllib.request.urlopen(request, timeout=45)
            if raw:
                return response
            with response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in RETRYABLE and exc.code != 403:
                raise
            if attempt >= 5:
                raise
            retry_after = exc.headers.get("Retry-After")
            try:
                delay = float(retry_after) if retry_after else None
            except ValueError:
                delay = None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            last = exc
            if attempt >= 5:
                raise
            delay = None
        if delay is None:
            delay = min(20.0, 0.8 * (2**attempt)) + random.random() * 0.5
        time.sleep(delay)
    raise RuntimeError(f"Drive request failed: {last}")


def list_music(root_id: str, api_key: str) -> tuple[str, list[dict]]:
    info = drive_request(
        f"/{root_id}",
        {"fields": "id,name,mimeType"},
        api_key,
    )
    if info.get("mimeType") != "application/vnd.google-apps.folder":
        raise RuntimeError("Configured music root is not a Drive folder.")

    visited: set[str] = set()
    files: dict[str, dict] = {}
    frontier = [{"id": root_id, "path": info.get("name") or "Music"}]

    def read_folder(current: dict) -> list[dict]:
        children = []
        token = ""
        seen_tokens: set[str] = set()
        while True:
            params = {
                "q": f"'{current['id']}' in parents and trashed = false",
                "pageSize": "1000",
                "fields": "nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,md5Checksum,capabilities(canDownload))",
            }
            if token:
                params["pageToken"] = token
            page = drive_request("", params, api_key)
            if page.get("incompleteSearch") or not isinstance(page.get("files"), list):
                raise RuntimeError("Drive returned an incomplete listing; migration stopped.")
            for item in page["files"]:
                fid = item.get("id", "")
                name = item.get("name", "")
                if not ID_RE.match(fid) or not isinstance(name, str):
                    continue
                if item.get("mimeType") == "application/vnd.google-apps.folder":
                    children.append({"id": fid, "path": f"{current['path']}/{name}"})
                elif AUDIO_RE.search(name):
                    record = {
                        **item,
                        "folder": current["path"],
                        "availability": "blocked"
                        if item.get("capabilities", {}).get("canDownload") is False
                        else "ready",
                    }
                    with LOG_LOCK:
                        files[fid] = record
            token = page.get("nextPageToken") or ""
            if not token:
                break
            if token in seen_tokens:
                raise RuntimeError("Drive pagination repeated; migration stopped.")
            seen_tokens.add(token)
        return children

    while frontier:
        level = []
        for current in frontier:
            if current["id"] in visited:
                continue
            if len(visited) >= 5000:
                raise RuntimeError("Music root contains more than 5,000 folders.")
            visited.add(current["id"])
            level.append(current)
        frontier = []
        for offset in range(0, len(level), 6):
            batch = level[offset : offset + 6]
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(batch))) as pool:
                for children in pool.map(read_folder, batch):
                    frontier.extend(children)
            log(f"Drive inventory: {len(files)} audio files across {len(visited)} folders")

    result = sorted(files.values(), key=lambda item: item["id"])
    return info.get("name") or "Music", result


def object_key(file: dict) -> str:
    name = file.get("name", "")
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else "bin"
    if not EXT_RE.match(ext):
        ext = "bin"
    md5 = (file.get("md5Checksum") or "").lower()
    if re.fullmatch(r"[a-f0-9]{32}", md5):
        version = md5
    else:
        fallback = f"{file.get('size','')}|{file.get('modifiedTime','')}|{name}".encode()
        version = hashlib.sha256(fallback).hexdigest()[:32]
    return f"audio/{file['id']}/{version}.{ext}"


def content_type(file: dict) -> str:
    mime = (file.get("mimeType") or "").strip()
    if mime.startswith("audio/"):
        return mime
    guessed = mimetypes.guess_type(file.get("name", ""))[0]
    return guessed or "application/octet-stream"


def r2_client(account_id: str, access_key: str, secret_key: str):
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=Config(
            signature_version="s3v4",
            retries={"max_attempts": 10, "mode": "adaptive"},
            connect_timeout=20,
            read_timeout=90,
            max_pool_connections=16,
        ),
    )


def remote_is_verified(client, bucket: str, key: str, file: dict) -> bool:
    try:
        head = client.head_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in {"404", "NoSuchKey", "NotFound"} or status == 404:
            return False
        raise
    if int(head.get("ContentLength", -1)) != int(file.get("size", -2)):
        return False
    expected_md5 = (file.get("md5Checksum") or "").lower()
    stored_md5 = (head.get("Metadata") or {}).get("source-md5", "").lower()
    return not expected_md5 or stored_md5 == expected_md5


def download_drive_file(file: dict, api_key: str, destination: Path) -> tuple[int, str]:
    params = {"alt": "media"}
    url = f"{DRIVE_ROOT}/{file['id']}?{urllib.parse.urlencode({**params, 'key': api_key})}"
    expected_size = int(file["size"])
    expected_md5 = (file.get("md5Checksum") or "").lower()

    for attempt in range(6):
        md5 = hashlib.md5()
        total = 0
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": "jarvis-r2-migrator/1.0", "Accept": "*/*"},
            )
            with urllib.request.urlopen(request, timeout=90) as response, destination.open("wb") as out:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > expected_size:
                        raise RuntimeError("Drive response exceeded expected file size.")
                    md5.update(chunk)
                    out.write(chunk)
            digest = md5.hexdigest()
            if total != expected_size:
                raise RuntimeError(f"Drive response was incomplete ({total}/{expected_size} bytes).")
            if expected_md5 and digest != expected_md5:
                raise RuntimeError("Drive MD5 verification failed.")
            return total, digest
        except urllib.error.HTTPError as exc:
            if exc.code not in RETRYABLE and exc.code != 403:
                raise
            error = exc
        except (urllib.error.URLError, TimeoutError, ConnectionError, RuntimeError) as exc:
            error = exc
        destination.unlink(missing_ok=True)
        if attempt >= 5:
            raise RuntimeError(f"Download failed after retries: {error}") from error
        time.sleep(min(20.0, 1.0 * (2**attempt)) + random.random() * 0.5)
    raise RuntimeError("Unreachable download failure.")


def migrate_one(client, bucket: str, api_key: str, public_base: str, temp_root: Path, file: dict) -> dict:
    if file.get("availability") != "ready":
        raise RuntimeError("Drive reports this file as non-downloadable.")
    size = int(file.get("size") or 0)
    if size <= 0:
        raise RuntimeError("Invalid Drive file size.")

    key = object_key(file)
    if remote_is_verified(client, bucket, key, file):
        status = "skipped"
    else:
        suffix = key.rsplit(".", 1)[-1]
        tmp = temp_root / f"{file['id']}.{suffix}.part"
        download_drive_file(file, api_key, tmp)
        metadata = {
            "source-drive-id": file["id"],
            "source-md5": (file.get("md5Checksum") or "").lower(),
            "source-size": str(size),
        }
        client.upload_file(
            str(tmp),
            bucket,
            key,
            ExtraArgs={
                "ContentType": content_type(file),
                "CacheControl": "public, max-age=31536000, immutable",
                "Metadata": metadata,
            },
        )
        tmp.unlink(missing_ok=True)
        if not remote_is_verified(client, bucket, key, file):
            raise RuntimeError("R2 verification HEAD did not match uploaded object.")
        status = "copied"

    url = f"{public_base.rstrip('/')}/{key}" if public_base else ""
    return {
        "driveId": file["id"],
        "key": key,
        "url": url,
        "name": file.get("name", ""),
        "folder": file.get("folder", ""),
        "size": size,
        "md5": (file.get("md5Checksum") or "").lower(),
        "mimeType": content_type(file),
        "modifiedTime": file.get("modifiedTime", ""),
        "status": status,
    }


def upload_json(client, bucket: str, key: str, payload: dict, *, cache_control: str) -> None:
    body = (json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentType="application/json; charset=utf-8",
        CacheControl=cache_control,
    )
    head = client.head_object(Bucket=bucket, Key=key)
    if int(head.get("ContentLength", -1)) != len(body):
        raise RuntimeError(f"R2 verification failed for {key}.")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=5, help="0 means full library; positive values are smoke-test item counts")
    parser.add_argument("--concurrency", type=int, default=4)
    args = parser.parse_args()
    if args.limit < 0 or args.concurrency < 1 or args.concurrency > 8:
        raise RuntimeError("Invalid limit/concurrency.")

    api_key = required_env("GOOGLE_DRIVE_API_KEY")
    account_id = required_env("R2_ACCOUNT_ID")
    access_key = required_env("R2_ACCESS_KEY_ID")
    secret_key = required_env("R2_SECRET_ACCESS_KEY")
    bucket = required_env("R2_BUCKET")
    public_base = os.environ.get("R2_PUBLIC_BASE_URL", "").strip()

    repo_root = Path(__file__).resolve().parents[1]
    config = json.loads((repo_root / "public/assets/drive-config.json").read_text("utf-8"))
    root_id = os.environ.get("MUSIC_ROOT_ID", config.get("folderId", "")).strip()
    if not ID_RE.match(root_id):
        raise RuntimeError("Invalid Drive music root ID.")

    client = r2_client(account_id, access_key, secret_key)
    client.head_bucket(Bucket=bucket)
    log(f"R2 destination verified: bucket={bucket}")
    root_name, inventory = list_music(root_id, api_key)
    total_inventory_bytes = sum(int(item.get("size") or 0) for item in inventory)
    log(f"Authoritative Drive inventory: {len(inventory)} tracks, {total_inventory_bytes / 1_000_000_000:.2f} GB")

    selected = inventory if args.limit == 0 else inventory[: args.limit]
    mode = "full" if args.limit == 0 else "smoke"
    log(f"Starting {mode} migration for {len(selected)} tracks with concurrency={args.concurrency}")

    results: list[dict] = []
    failures: list[dict] = []
    completed = 0
    with tempfile.TemporaryDirectory(prefix="drive-r2-") as tmp:
        temp_root = Path(tmp)
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            future_map = {
                pool.submit(migrate_one, client, bucket, api_key, public_base, temp_root, item): item
                for item in selected
            }
            for future in concurrent.futures.as_completed(future_map):
                item = future_map[future]
                try:
                    results.append(future.result())
                except Exception as exc:
                    failures.append({"driveId": item.get("id"), "name": item.get("name"), "error": str(exc)[:500]})
                    log(f"FAILED {item.get('id')}: {str(exc)[:200]}")
                completed += 1
                if completed % 25 == 0 or completed == len(selected):
                    copied = sum(1 for r in results if r["status"] == "copied")
                    skipped = sum(1 for r in results if r["status"] == "skipped")
                    log(f"Progress {completed}/{len(selected)} · copied={copied} skipped={skipped} failed={len(failures)}")

    results.sort(key=lambda r: r["driveId"])
    report = {
        "version": 1,
        "mode": mode,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "driveRootId": root_id,
        "driveRootName": root_name,
        "r2Bucket": bucket,
        "publicBaseUrl": public_base,
        "inventoryCount": len(inventory),
        "inventoryBytes": total_inventory_bytes,
        "selectedCount": len(selected),
        "verifiedCount": len(results),
        "copiedCount": sum(1 for r in results if r["status"] == "copied"),
        "skippedCount": sum(1 for r in results if r["status"] == "skipped"),
        "failedCount": len(failures),
        "failures": failures,
        "files": results,
    }
    report_path = repo_root / "r2-migration-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")

    if failures:
        log(f"Migration incomplete: {len(failures)} files failed. Safe to rerun; verified R2 objects will be skipped.")
        return 2

    catalog_key = "catalog/drive-r2-map-v1.json" if mode == "full" else "catalog/drive-r2-smoke-v1.json"
    upload_json(client, bucket, catalog_key, report, cache_control="no-cache")
    if mode == "full" and len(results) != len(inventory):
        raise RuntimeError("Refusing to publish incomplete canonical R2 mapping.")
    log(f"Migration verified. Published {catalog_key} with {len(results)} objects.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise
    except Exception as exc:
        print(f"Migration failed: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
