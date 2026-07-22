"""Shared helpers for extractors: the output bundle, image saving, text hygiene.

Every extractor is handed a :class:`Bundle` and fills it in. The bundle owns the
output directory layout that the Node server and the librarian agent rely on::

    <out_dir>/
        extraction.md      # human/agent-readable text + structure  (bundle.md)
        pages/page-001.png # full-page renders for vision            (bundle.pages)
        media/img-001.png  # embedded images / charts pulled out     (bundle.media)

The manifest returned by :meth:`Bundle.result` is printed as JSON on stdout by
``extract.py`` and consumed by the server.
"""
from __future__ import annotations

import io
import os
import re
from dataclasses import dataclass, field


def sanitize_text(s) -> str:
    """Collapse control chars / weird whitespace so extractions stay readable."""
    if s is None:
        return ""
    s = str(s)
    # normalise newlines, strip other C0 control chars except tab/newline
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s)
    return s


def human_size(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


class Bundle:
    """Accumulates one file's extraction output and writes it to ``out_dir``."""

    def __init__(self, source: str, out_dir: str, kind: str):
        self.source = source
        self.out_dir = out_dir
        self.kind = kind
        self._md_parts: list[str] = []
        self.pages: list[str] = []          # absolute page-render paths
        self.media: list[dict] = []         # {"path","desc"} embedded images
        self.html: str | None = None        # absolute path to a rich HTML view
        self.meta: dict = {}
        self.warnings: list[str] = []
        self._page_i = 0
        self._media_i = 0
        os.makedirs(out_dir, exist_ok=True)

    # -- markdown body ------------------------------------------------------
    def add(self, *lines: str) -> None:
        for ln in lines:
            self._md_parts.append(sanitize_text(ln))

    def heading(self, text: str, level: int = 2) -> None:
        self.add("", f"{'#' * level} {sanitize_text(text)}", "")

    def warn(self, msg: str) -> None:
        self.warnings.append(str(msg)[:400])

    # -- images -------------------------------------------------------------
    def _pages_dir(self) -> str:
        d = os.path.join(self.out_dir, "pages")
        os.makedirs(d, exist_ok=True)
        return d

    def _media_dir(self) -> str:
        d = os.path.join(self.out_dir, "media")
        os.makedirs(d, exist_ok=True)
        return d

    def add_page_png(self, data: bytes, label: str | None = None) -> str:
        """Save a full-page render; returns its absolute path."""
        self._page_i += 1
        path = os.path.join(self._pages_dir(), f"page-{self._page_i:03d}.png")
        with open(path, "wb") as f:
            f.write(data)
        self.pages.append(path)
        return path

    def add_media(self, data: bytes, ext: str = "png", desc: str = "") -> str | None:
        """Save an embedded image; skips tiny (icon/spacer) images."""
        # ignore obvious spacers/bullets: < 2 KB and undecodable-as-real-image
        if len(data) < 1024:
            return None
        self._media_i += 1
        ext = (ext or "png").lstrip(".").lower()
        path = os.path.join(self._media_dir(), f"img-{self._media_i:03d}.{ext}")
        with open(path, "wb") as f:
            f.write(data)
        self.media.append({"path": path, "desc": desc[:200]})
        return path

    def add_html(self, content: str, name: str = "view.html") -> str:
        """Save a rich HTML rendering (e.g. spreadsheet tables) for the viewer."""
        path = os.path.join(self.out_dir, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        self.html = path
        return path

    # -- output -------------------------------------------------------------
    def write(self) -> str:
        md_path = os.path.join(self.out_dir, "extraction.md")
        with open(md_path, "w", encoding="utf-8") as f:
            f.write("\n".join(self._md_parts).rstrip() + "\n")
        return md_path

    def result(self) -> dict:
        md_path = self.write()
        return {
            "ok": True,
            "kind": self.kind,
            "source": self.source.replace(os.sep, "/"),
            "textFile": md_path.replace(os.sep, "/"),
            "pages": [p.replace(os.sep, "/") for p in self.pages],
            "pageCount": len(self.pages),
            "html": self.html.replace(os.sep, "/") if self.html else None,
            "media": [{"path": m["path"].replace(os.sep, "/"), "desc": m["desc"]} for m in self.media],
            "meta": self.meta,
            "warnings": self.warnings,
        }


def normalize_to_png(data: bytes) -> bytes | None:
    """Best-effort convert arbitrary image bytes to PNG via Pillow."""
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(data))
        if im.mode in ("P", "RGBA", "LA"):
            im = im.convert("RGBA")
        elif im.mode != "RGB":
            im = im.convert("RGB")
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        return None
