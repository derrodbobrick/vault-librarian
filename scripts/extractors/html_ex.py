"""HTML and RTF -> clean Markdown.

HTML: strip scripts/styles/nav chrome, convert the main content to Markdown.
RTF:  strip control words to plain text (striprtf), or LibreOffice if richer
      fidelity/rendering is wanted.
"""
from __future__ import annotations

import os

from .common import Bundle


def _extract_html(src: str, b: Bundle) -> None:
    from bs4 import BeautifulSoup
    from markdownify import markdownify as md

    with open(src, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read()
    soup = BeautifulSoup(raw, "html.parser")
    title = (soup.title.string.strip() if soup.title and soup.title.string else os.path.basename(src))
    b.meta = {"title": title}
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    main = soup.find("main") or soup.find("article") or soup.body or soup
    b.add(f"# {title}")
    b.add("")
    b.add(md(str(main), heading_style="ATX", strip=["a"]).strip())
    # note images referenced (agent can fetch/inspect if local)
    imgs = [img.get("src") for img in soup.find_all("img") if img.get("src")]
    if imgs:
        b.meta["imageRefs"] = imgs[:50]
        b.add("", f"Referenced images ({len(imgs)}): " + ", ".join(imgs[:20]))


def _extract_rtf(src: str, b: Bundle) -> None:
    from striprtf.striprtf import rtf_to_text

    with open(src, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read()
    b.add(f"# RTF document: {os.path.basename(src)}")
    b.add("")
    b.add(rtf_to_text(raw).strip())


def extract(src: str, out_dir: str, max_pages: int = 0) -> dict:
    ext = os.path.splitext(src)[1].lower()
    b = Bundle(src, out_dir, "html" if ext in (".html", ".htm") else "rtf")
    if ext in (".html", ".htm"):
        _extract_html(src, b)
    else:
        _extract_rtf(src, b)
    return b.result()
