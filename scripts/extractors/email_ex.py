"""Email extraction for .eml (stdlib) and .msg (extract-msg / Outlook).

Captures headers (from/to/subject/date), the body, and lists attachments. Each
attachment's bytes are pulled out as media so the pipeline can, in turn, extract
those too (the caller re-ingests them).
"""
from __future__ import annotations

import os

from .common import Bundle


def _extract_eml(src: str, b: Bundle) -> None:
    from email import policy
    from email.parser import BytesParser

    with open(src, "rb") as f:
        msg = BytesParser(policy=policy.default).parse(f)
    _headers(b, msg.get("from", ""), msg.get("to", ""), msg.get("cc", ""),
             msg.get("subject", ""), msg.get("date", ""))
    body = ""
    try:
        part = msg.get_body(preferencelist=("plain", "html"))
        if part is not None:
            body = part.get_content()
            if part.get_content_subtype() == "html":
                from bs4 import BeautifulSoup
                body = BeautifulSoup(body, "html.parser").get_text("\n")
    except Exception:
        pass
    b.heading("Body", 2)
    b.add(body.strip() or "*(no text body)*")

    atts = []
    for part in msg.iter_attachments():
        name = part.get_filename() or "attachment"
        data = part.get_payload(decode=True) or b""
        atts.append(name)
        _save_attachment(b, name, data)
    _attachment_note(b, atts)


def _extract_msg(src: str, b: Bundle) -> None:
    import extract_msg

    m = extract_msg.Message(src)
    _headers(b, m.sender or "", m.to or "", m.cc or "", m.subject or "", str(m.date or ""))
    b.heading("Body", 2)
    b.add((m.body or "").strip() or "*(no text body)*")
    atts = []
    for att in m.attachments:
        name = att.longFilename or att.shortFilename or "attachment"
        data = att.data if isinstance(att.data, (bytes, bytearray)) else b""
        atts.append(name)
        _save_attachment(b, name, data)
    _attachment_note(b, atts)
    m.close()


def _headers(b: Bundle, frm, to, cc, subject, date):
    b.meta = {"from": frm, "to": to, "subject": subject, "date": date}
    b.add(f"# Email: {subject or '(no subject)'}")
    b.add(f"- From: {frm}")
    b.add(f"- To: {to}")
    if cc:
        b.add(f"- Cc: {cc}")
    b.add(f"- Date: {date}")


def _save_attachment(b: Bundle, name: str, data: bytes):
    if not data:
        return
    # write raw attachment bytes into the media dir under its real name so the
    # server/agent can re-ingest it with the right extractor
    d = os.path.join(b.out_dir, "attachments")
    os.makedirs(d, exist_ok=True)
    safe = name.replace(os.sep, "_").replace("/", "_")
    path = os.path.join(d, safe)
    with open(path, "wb") as f:
        f.write(data)
    b.media.append({"path": path.replace(os.sep, "/"), "desc": f"email attachment: {name}"})


def _attachment_note(b: Bundle, atts):
    b.meta["attachments"] = atts
    if atts:
        b.heading("Attachments", 2)
        for a in atts:
            b.add(f"- {a}")
        b.add("", "> Attachment files were saved alongside this extraction "
              "(the server re-ingests them for their own extraction).")


def extract(src: str, out_dir: str, max_pages: int = 0) -> dict:
    ext = os.path.splitext(src)[1].lower()
    b = Bundle(src, out_dir, "email")
    if ext == ".msg":
        _extract_msg(src, b)
    else:
        _extract_eml(src, b)
    return b.result()
