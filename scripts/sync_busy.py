"""
Fetch Race's iCloud calendar feed(s) and write busy.json for the booking page.

Only start/end times are written. Event titles, locations, notes and attendees
never leave this script, so nothing private ends up on the public site.

Reads the feed URL(s) from the ICAL_URLS environment variable (a GitHub
secret). Put one URL per line to merge several calendars. webcal:// links
from iCloud's "Public Calendar" share are accepted as-is.
"""

import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import icalendar
import recurring_ical_events

HOME_TZ = ZoneInfo("America/New_York")
DAYS_AHEAD = 60
OUT_FILE = os.path.join(os.path.dirname(__file__), "..", "busy.json")


def fetch(url: str) -> bytes:
    url = url.strip()
    if url.startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; calendar-sync)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def to_utc(value) -> datetime:
    """Turn an iCal DATE or DATE-TIME into an aware UTC datetime."""
    if isinstance(value, datetime):
        if value.tzinfo is None:  # floating time: treat as Eastern
            value = value.replace(tzinfo=HOME_TZ)
        return value.astimezone(timezone.utc)
    # All-day DATE: block the whole local day
    return datetime(value.year, value.month, value.day, tzinfo=HOME_TZ).astimezone(timezone.utc)


def busy_blocks(cal, start: datetime, end: datetime):
    for ev in recurring_ical_events.of(cal).between(start, end):
        if str(ev.get("TRANSP", "OPAQUE")).upper() == "TRANSPARENT":
            continue  # marked "Free" in Calendar
        if str(ev.get("STATUS", "")).upper() == "CANCELLED":
            continue
        dtstart = ev.get("DTSTART")
        if dtstart is None:
            continue
        s = dtstart.dt
        dtend = ev.get("DTEND")
        if dtend is not None:
            e = dtend.dt
        elif ev.get("DURATION") is not None:
            e = s + ev.get("DURATION").dt
        elif isinstance(s, datetime):
            e = s
        else:
            e = s + timedelta(days=1)
        yield to_utc(s), to_utc(e)


def merge(blocks):
    merged = []
    for s, e in sorted(blocks):
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged


def fail(msg: str):
    # ::error:: shows up as a run annotation, readable without the full logs
    print(f"::error::{msg}")
    sys.exit(1)


def main():
    raw = os.environ.get("ICAL_URLS", "")
    urls = [u.strip() for u in raw.replace(",", "\n").split() if u.strip()]
    if not urls:
        fail("ICAL_URLS secret is empty or missing")

    now = datetime.now(timezone.utc)
    window_end = now + timedelta(days=DAYS_AHEAD)
    blocks = []
    for i, url in enumerate(urls, 1):
        host = urllib.parse.urlsplit(url.replace("webcal://", "https://")).hostname
        label = f"calendar {i} of {len(urls)} ({host})"
        try:
            data = fetch(url)
        except Exception as exc:
            fail(f"{label}: download failed: {type(exc).__name__}: {exc}")
        try:
            cal = icalendar.Calendar.from_ical(data)
            found = list(busy_blocks(cal, now - timedelta(days=1), window_end))
        except Exception as exc:
            fail(f"{label}: could not read calendar: {type(exc).__name__}: {exc}")
        print(f"{label}: {len(found)} events")
        blocks.extend(found)

    fmt = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
    busy = [{"start": fmt(s), "end": fmt(e)} for s, e in merge(blocks) if e > now]

    # Only rewrite the file (and so only commit) when the busy times changed.
    try:
        with open(OUT_FILE) as f:
            if json.load(f).get("busy") == busy:
                print("No change in busy times")
                return
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    with open(OUT_FILE, "w") as f:
        json.dump({"updated": fmt(now), "busy": busy}, f, indent=1)
    print(f"Wrote {len(busy)} busy blocks")


if __name__ == "__main__":
    main()
