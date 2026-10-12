"""
Email each person a reminder with the Zoom link ~30 minutes before their call.

Runs every 5 minutes from .github/workflows/booking-reminders.yml:
  1. Logs into Race's Gmail (IMAP, app password) and finds "New call booked"
     emails sent by the booking page.
  2. Stars new booking emails.
  3. Reads the booking details from the "Add to your calendar" link in each
     email, and when a call is <= 35 minutes away, sends the reminder from
     Race's Gmail (SMTP), then labels that email "Reminder Sent" so it is
     never sent twice.

Python standard library only.
"""

import base64
import email
import imaplib
import json
import os
import re
import smtplib
import sys
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr
from html import escape
from zoneinfo import ZoneInfo

OWNER = "Race Grinder"
GMAIL = os.environ.get("GMAIL_ADDRESS", "racejgrinder@gmail.com")
PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "")
HOME_TZ = "America/New_York"
SEND_WHEN_WITHIN = timedelta(minutes=35)
SENT_LABEL = "Reminder Sent"
SUBJECT_MATCH = '\\"New call booked\\"'
TOKEN_RE = re.compile(r"#add=([A-Za-z0-9_-]+)")
ROOT = os.path.join(os.path.dirname(__file__), "..")


def fail(msg: str):
    print(f"::error::{msg}")
    sys.exit(1)


def zoom_link() -> str:
    """Single source of truth: the zoomLink in schedule.js."""
    with open(os.path.join(ROOT, "schedule.js")) as f:
        m = re.search(r"zoomLink:\s*'([^']*)'", f.read())
    return m.group(1) if m else ""


def decode_token(token: str) -> dict:
    padded = token + "=" * (-len(token) % 4)
    return json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))


def booking_from_message(raw: bytes):
    msg = email.message_from_bytes(raw)
    for part in msg.walk():
        if part.get_content_maintype() != "text":
            continue
        payload = part.get_payload(decode=True) or b""
        text = payload.decode(part.get_content_charset() or "utf-8", "replace")
        m = TOKEN_RE.search(text)
        if m:
            try:
                info = decode_token(m.group(1))
                start = datetime.fromisoformat(info["s"].replace("Z", "+00:00"))
                return info, start
            except Exception:
                continue
    return None, None


def local_tz(name):
    try:
        return ZoneInfo(name or HOME_TZ)
    except Exception:
        return ZoneInfo(HOME_TZ)


def build_reminder(info: dict, start: datetime, link: str) -> EmailMessage:
    tz = local_tz(info.get("z"))
    local = start.astimezone(tz)
    time_str = local.strftime("%-I:%M %p %Z")
    date_str = local.strftime("%A, %B %-d")
    first = (info.get("n") or "there").split()[0]

    msg = EmailMessage()
    msg["Subject"] = f"Starting soon: your call with {OWNER} at {time_str}"
    msg["From"] = formataddr((OWNER, GMAIL))
    msg["To"] = info["e"]
    msg["Reply-To"] = GMAIL

    msg.set_content(
        f"Hi {first},\n\n"
        f"Quick reminder that our call starts at {time_str} today ({date_str}).\n\n"
        f"Join on Zoom: {link}\n\n"
        f"See you soon,\n{OWNER}\n"
    )
    msg.add_alternative(f"""\
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1F332A;max-width:520px;line-height:1.6">
  <p style="margin:0 0 14px">Hi {escape(first)},</p>
  <p style="margin:0 0 20px">Quick reminder that our call starts at
    <strong>{escape(time_str)}</strong> today ({escape(date_str)}).</p>
  <p style="margin:0 0 24px">
    <a href="{escape(link)}" style="display:inline-block;background:#2F4A3C;color:#FBF8F1;
       text-decoration:none;font-weight:600;padding:12px 26px;border-radius:24px">Join on Zoom</a>
  </p>
  <p style="margin:0 0 4px;font-size:13px;color:#8A7C6E">Or open this link: {escape(link)}</p>
  <p style="margin:24px 0 0">See you soon,<br>{OWNER}</p>
</div>""", subtype="html")
    return msg


def search(imap, query: str):
    status, data = imap.uid("SEARCH", "X-GM-RAW", f'"{query}"')
    if status != "OK":
        fail(f"Gmail search failed: {data}")
    return data[0].split() if data and data[0] else []


def main():
    if not PASSWORD:
        print("::warning::GMAIL_APP_PASSWORD secret not set yet; skipping reminders")
        return

    link = zoom_link()
    now = datetime.now(timezone.utc)

    try:
        imap = imaplib.IMAP4_SSL("imap.gmail.com")
        imap.login(GMAIL, PASSWORD)
    except imaplib.IMAP4.error as exc:
        fail(f"Gmail login failed (check the app password): {exc}")

    if imap.select('"[Gmail]/All Mail"')[0] != "OK":
        imap.select("INBOX")

    # Star new booking emails
    new = search(imap, f"subject:{SUBJECT_MATCH} newer_than:1d -is:starred")
    if new:
        imap.uid("STORE", b",".join(new), "+FLAGS", "(\\Flagged)")
        print(f"Starred {len(new)} booking email(s)")

    # Send reminders that are due
    pending = search(imap, f"subject:{SUBJECT_MATCH} newer_than:30d -label:reminder-sent")
    due = []
    for uid in pending:
        status, data = imap.uid("FETCH", uid, "(BODY.PEEK[])")
        if status != "OK" or not data or not isinstance(data[0], tuple):
            continue
        info, start = booking_from_message(data[0][1])
        if not info or not info.get("e"):
            continue
        if timedelta(0) < start - now <= SEND_WHEN_WITHIN:
            due.append((uid, info, start))

    if not due:
        print(f"No reminders due ({len(pending)} upcoming or past booking(s) checked)")
        imap.logout()
        return

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(GMAIL, PASSWORD)
        for uid, info, start in due:
            smtp.send_message(build_reminder(info, start, link))
            imap.uid("STORE", uid, "+X-GM-LABELS", f'("{SENT_LABEL}")')
            print(f"Sent reminder for call at {start.isoformat()}")

    imap.logout()


if __name__ == "__main__":
    main()
