"""Rendering helpers: turn documents into full-page PNGs the agent can *see*.

Two paths:
  * PDFs render directly with PyMuPDF (no external dependency).
  * Office documents are converted to PDF by LibreOffice (`soffice`) first,
    then rendered the same way. If LibreOffice is missing, callers degrade to
    text-only extraction and record a warning.
"""
from __future__ import annotations

import glob
import os
import shutil
import subprocess
import tempfile

RENDER_DPI = 150          # legible for charts/tables without huge files
SOFFICE_TIMEOUT = 180     # seconds for a single conversion


def find_soffice() -> str | None:
    """Locate the LibreOffice binary on PATH or in common install dirs."""
    for name in ("soffice", "soffice.exe", "soffice.com"):
        p = shutil.which(name)
        if p:
            return p
    candidates = [
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        "/usr/bin/soffice",
        "/usr/local/bin/soffice",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


def render_pdf_pages(pdf_path: str, bundle, max_pages: int = 0) -> int:
    """Render each PDF page to a PNG in the bundle. Returns pages rendered.

    ``max_pages`` <= 0 renders every page.
    """
    import fitz  # PyMuPDF

    doc = fitz.open(pdf_path)
    try:
        n = doc.page_count
        limit = n if max_pages <= 0 else min(n, max_pages)
        for i in range(limit):
            page = doc.load_page(i)
            pix = page.get_pixmap(dpi=RENDER_DPI)
            bundle.add_page_png(pix.tobytes("png"))
        if limit < n:
            bundle.warn(f"Rendered first {limit} of {n} pages.")
        return limit
    finally:
        doc.close()


def office_to_pdf(src_path: str) -> str | None:
    """Convert an Office document to PDF via LibreOffice. Returns temp PDF path.

    Caller is responsible for cleaning up the returned file's parent dir.
    """
    soffice = find_soffice()
    if not soffice:
        return None
    out_dir = tempfile.mkdtemp(prefix="vl_render_")
    # A dedicated user profile dir avoids clashes with a running LibreOffice.
    profile = os.path.join(out_dir, "profile")
    try:
        subprocess.run(
            [
                soffice, "--headless", "--norestore", "--nolockcheck",
                f"-env:UserInstallation=file:///{profile.replace(os.sep, '/')}",
                "--convert-to", "pdf", "--outdir", out_dir, src_path,
            ],
            timeout=SOFFICE_TIMEOUT,
            capture_output=True,
        )
    except Exception:
        return None
    pdfs = glob.glob(os.path.join(out_dir, "*.pdf"))
    return pdfs[0] if pdfs else None


def render_office_pages(src_path: str, bundle, max_pages: int = 0) -> int:
    """Render an Office doc's pages via LibreOffice->PDF->PNG. 0 if unavailable."""
    pdf = office_to_pdf(src_path)
    if not pdf:
        if not find_soffice():
            bundle.warn("LibreOffice not found — skipping full-page renders "
                        "(text/structure extracted, layout not visually captured).")
        else:
            bundle.warn("LibreOffice conversion failed — skipping full-page renders.")
        return 0
    try:
        return render_pdf_pages(pdf, bundle, max_pages)
    finally:
        parent = os.path.dirname(pdf)
        shutil.rmtree(parent, ignore_errors=True)
