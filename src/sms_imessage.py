#!/usr/bin/env python3
"""Poll macOS Messages (iMessage) until an OTP code is found."""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote


@dataclass
class MessageConfig:
    code_regex: str
    timeout_seconds: int
    poll_interval_seconds: int
    since_seconds: int


def parse_args() -> MessageConfig:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-json", required=True)
    args = parser.parse_args()
    raw = json.loads(args.config_json)
    return MessageConfig(
        code_regex=raw.get("codeRegex", r"\b(\d{6})\b"),
        timeout_seconds=int(raw.get("timeoutSeconds", 300)),
        poll_interval_seconds=int(raw.get("pollIntervalSeconds", 2)),
        since_seconds=int(raw.get("sinceSeconds", 600)),
    )


def get_messages_db_path() -> str | None:
    """Get the path to macOS Messages database."""
    db_path = Path.home() / "Library" / "Messages" / "chat.db"
    if db_path.exists():
        return str(db_path)
    return None


def connect_messages_db(db_path: str) -> sqlite3.Connection:
    """Open Messages DB read-only so SQLite does not need write access there."""
    uri_path = quote(db_path)
    conn = sqlite3.connect(f"file:{uri_path}?mode=ro", uri=True, timeout=5)
    conn.execute("PRAGMA query_only = ON")
    return conn


def poll_for_code_from_messages(config: MessageConfig) -> str:
    """Poll iMessage database for OTP code from SMS containing verification keywords."""
    db_path = get_messages_db_path()
    if not db_path:
        raise RuntimeError(
            "Messages database not found. "
            "Expected: ~/Library/Messages/chat.db"
        )

    print(f"[sms-test] Messages database: {db_path}", file=sys.stderr, flush=True)

    deadline = time.time() + config.timeout_seconds
    pattern = re.compile(config.code_regex)
    
    # Calculate cutoff in nanoseconds (macOS epoch: Jan 1, 2001)
    # macOS epoch is 978307200 seconds before Unix epoch (Jan 1, 1970)
    now_unix = time.time()  # Unix timestamp
    now_macos = (now_unix - 978307200) * 1_000_000_000  # Convert to macOS nanoseconds
    cutoff_ns = int(now_macos - (config.since_seconds * 1_000_000_000))
    
    attempt = 0

    while time.time() < deadline:
        attempt += 1
        remaining = max(0, int(deadline - time.time()))
        print(
            f"[sms-test] Poll {attempt}: checking Messages for verification codes "
            f"({remaining}s remaining)",
            file=sys.stderr,
            flush=True,
        )

        try:
            conn = connect_messages_db(db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            # Query messages containing verification keywords (SMS or iMessage)
            # Note: date in Messages is in nanoseconds (Unix epoch * 1 billion + macOS epoch offset)
            # macOS epoch (Jan 1, 2001) is 978307200 seconds after Unix epoch (Jan 1, 1970)
            cursor.execute("""
                SELECT m.ROWID, m.text, m.date, m.service
                FROM message m
                WHERE m.date >= ?
                AND m.text IS NOT NULL
                AND (m.text LIKE '%verification%' OR m.text LIKE '%secure%' OR m.text LIKE '%USCIS%')
                ORDER BY m.date DESC
                LIMIT 100
            """, (cutoff_ns,))

            candidates = []
            rows = cursor.fetchall()
            
            if rows:
                print(
                    f"[sms-test] Found {len(rows)} message(s) with verification keywords",
                    file=sys.stderr,
                    flush=True,
                )
                for row in rows:
                    text = row["text"]
                    service = row["service"] or "unknown"
                    if not text:
                        continue
                    
                    matched = pattern.search(text)
                    if matched:
                        code = matched.group(1) if matched.groups() else matched.group(0)
                        created_at = row["date"]
                        candidates.append((created_at, code, text, service))
                        print(
                            f"[sms-test]   ✓ Found code '{code}' via {service}: {text[:75]!r}",
                            file=sys.stderr,
                            flush=True,
                        )
            else:
                print(
                    f"[sms-test] No recent messages with verification keywords (looked back {config.since_seconds}s)",
                    file=sys.stderr,
                    flush=True,
                )
            
            if candidates:
                candidates.sort(key=lambda item: item[0], reverse=True)
                _, code, text, service = candidates[0]
                print(
                    f"[sms-test] ✓ Extracted code '{code}' from latest message",
                    file=sys.stderr,
                    flush=True,
                )
                print(code)
                conn.close()
                return code
            
            conn.close()

        except sqlite3.OperationalError as e:
            # Database might be locked if Messages app is using it
            error_msg = str(e).lower()
            if "authorization denied" in error_msg or "operation not permitted" in error_msg:
                print(
                    f"[sms-test] ❌ Full Disk Access permission required!\n"
                    f"[sms-test] Fix: System Settings > Privacy & Security > Full Disk Access\n"
                    f"[sms-test]      1. Click + and add Terminal.app or VS Code\n"
                    f"[sms-test]      2. Restart terminal/editor\n"
                    f"[sms-test]      3. Close Messages app\n"
                    f"[sms-test]      4. Try again",
                    file=sys.stderr, flush=True
                )
            else:
                print(f"[sms-test] Database error: {e}", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[sms-test] Error querying Messages: {e}", file=sys.stderr, flush=True)

        time.sleep(config.poll_interval_seconds)

    raise TimeoutError("Timed out waiting for verification code in Messages")


def main() -> int:
    config = parse_args()
    try:
        poll_for_code_from_messages(config)
        return 0
    except Exception as exc:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
