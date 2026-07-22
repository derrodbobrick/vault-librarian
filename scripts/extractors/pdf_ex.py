"""PDF extraction: text, tables, embedded images, and full-page renders.

The librarian gets both the *text layer* (for exact quotes, tables, metadata)
and a *visual render of every page* (for layout, charts, graphs, figures and
overall intent). Scanned/image-only PDFs have no text layer, so the renders are
the only signal — we flag that so the agent reads them with vision.
"""
from __future__ import annotations

from . import render
from .common import Bundle


def extract(src: str, out_dir: str, max_pages: int = 0) -> dict:
    import fitz  # PyMuPDF

    b = Bundle(src, out_dir, "pdf")
    doc = fitz.open(src)
    try:
        md = doc.metadata or {}
        b.meta = {
            "title": md.get("title") or "",
            "author": md.get("author") or "",
            "subject": md.get("subject") or "",
            "keywords": md.get("keywords") or "",
            "created": md.get("creationDate") or "",
            "pageCount": doc.page_count,
        }
        b.add(f"# PDF: {md.get('title') or src.split('/')[-1]}")
        meta_bits = [f"{k}: {v}" for k, v in b.meta.items() if v and k != "pageCount"]
        b.add(f"Pages: {doc.page_count}")
        if meta_bits:
            b.add(*[f"{bit}" for bit in meta_bits])

        # Table of contents / bookmarks reveal document structure & intent.
        toc = doc.get_toc() or []
        if toc:
            b.heading("Outline / bookmarks", 2)
            for lvl, title, page in toc:
                b.add(f"{'  ' * (lvl - 1)}- {title} (p.{page})")

        total_text_chars = 0
        for i in range(doc.page_count):
            page = doc.load_page(i)
            b.heading(f"Page {i + 1}", 2)

            text = page.get_text("text").strip()
            total_text_chars += len(text)

            # Tables — PyMuPDF's detector; render each as a Markdown grid.
            try:
                tabs = page.find_tables()
                tables = list(tabs.tables) if tabs else []
            except Exception:
                tables = []
            if tables:
                for ti, t in enumerate(tables):
                    b.add(f"*Table {ti + 1} on page {i + 1}:*")
                    try:
                        b.add(t.to_markdown())
                    except Exception:
                        for row in t.extract():
                            b.add("| " + " | ".join((c or "").replace("\n", " ") for c in row) + " |")
                    b.add("")

            if text:
                b.add(text)
            else:
                b.add("*(no extractable text on this page — see the page render)*")

            # Embedded raster images (charts/figures/photos) filed as media.
            for img in page.get_images(full=True):
                xref = img[0]
                try:
                    pix = fitz.Pixmap(doc, xref)
                    if pix.n >= 5:  # CMYK/alpha -> RGB
                        pix = fitz.Pixmap(fitz.csRGB, pix)
                    data = pix.tobytes("png")
                    b.add_media(data, "png", desc=f"image on page {i + 1}")
                except Exception:
                    pass

        # Scanned document heuristic: almost no text but has pages.
        if doc.page_count and total_text_chars < 40 * doc.page_count:
            b.meta["scanned"] = True
            b.add("", "> NOTE: This PDF has little or no text layer (likely scanned "
                  "or image-based). Rely on the page renders and read them visually.")

        # Full-page renders for layout / charts / visual intent.
        render.render_pdf_pages(src, b, max_pages)
    finally:
        doc.close()

    b.meta["embeddedImages"] = len(b.media)
    return b.result()
