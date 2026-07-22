"""Word (.docx) extraction -> Markdown, tables, embedded images, page renders.

Previously .docx files were filed as opaque binaries the agent could not read at
all. Now we convert structure to Markdown (headings by style, lists, tables),
pull out embedded images, and render the laid-out pages via LibreOffice.
"""
from __future__ import annotations

from .common import Bundle
from . import render


def _style_prefix(style_name: str) -> str:
    s = (style_name or "").lower()
    if s.startswith("heading"):
        try:
            lvl = int(s.replace("heading", "").strip())
            return "#" * min(max(lvl + 1, 2), 6) + " "
        except ValueError:
            return "## "
    if s == "title":
        return "# "
    if "list" in s or "bullet" in s:
        return "- "
    return ""


def _iter_block_items(parent):
    """Yield paragraphs and tables in document order."""
    from docx.document import Document as _Doc
    from docx.oxml.table import CT_Tbl
    from docx.oxml.text.paragraph import CT_P
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    body = parent.element.body
    for child in body.iterchildren():
        if isinstance(child, CT_P):
            yield Paragraph(child, parent)
        elif isinstance(child, CT_Tbl):
            yield Table(child, parent)


def extract(src: str, out_dir: str, max_pages: int = 0) -> dict:
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    b = Bundle(src, out_dir, "docx")
    doc = docx.Document(src)

    cp = doc.core_properties
    b.meta = {
        "title": cp.title or "",
        "author": cp.author or "",
        "created": str(cp.created or ""),
        "modified": str(cp.modified or ""),
        "subject": cp.subject or "",
    }
    b.add(f"# Word document: {cp.title or src.split('/')[-1]}")
    if cp.author:
        b.add(f"Author: {cp.author}")
    if cp.subject:
        b.add(f"Subject: {cp.subject}")
    b.add("")

    for block in _iter_block_items(doc):
        if isinstance(block, Paragraph):
            text = block.text.strip()
            if not text:
                continue
            b.add(_style_prefix(block.style.name if block.style else "") + text)
        elif isinstance(block, Table):
            rows = block.rows
            if not rows:
                continue
            for ri, row in enumerate(rows):
                cells = [c.text.replace("\n", " ").replace("|", "/").strip() for c in row.cells]
                b.add("| " + " | ".join(cells) + " |")
                if ri == 0:
                    b.add("| " + " | ".join(["---"] * len(cells)) + " |")
            b.add("")

    # Embedded images from the package relationships.
    try:
        for rel in doc.part.rels.values():
            if "image" in rel.reltype:
                blob = rel.target_part.blob
                ext = (rel.target_part.partname.ext or "png").lstrip(".")
                b.add_media(blob, ext, desc="embedded image")
    except Exception as e:
        b.warn(f"image extraction: {e}")
    b.meta["embeddedImages"] = len(b.media)

    render.render_office_pages(src, b, max_pages)
    return b.result()
