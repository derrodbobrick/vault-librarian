"""Unified file-extraction dispatcher for the vault-librarian ingestion pipeline.

Usage:
    python extract.py <input_file> <out_dir> [--max-pages N]

Routes the input to a format-specific extractor and writes an *extraction
bundle* into <out_dir>:
    extraction.md      text + structure (headings, tables, metadata, layout)
    pages/*.png        full-page renders for the agent's vision
    media/*.png        embedded images / charts pulled out of the document

A JSON manifest describing the bundle is printed to stdout, e.g.:
    {"ok": true, "kind": "pdf", "textFile": "...", "pages": [...],
     "media": [...], "meta": {...}, "warnings": [...]}

On failure it still prints valid JSON with "ok": false and an "error" string, so
the Node server can always parse the result.
"""
from __future__ import annotations

import json
import os
import sys

# Ensure the extractors package (sibling dir) is importable when run directly.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

EXTRACTORS = {
    ".pdf": "pdf_ex",
    ".xlsx": "xlsx_ex", ".xlsm": "xlsx_ex",
    ".docx": "docx_ex",
    ".pptx": "pptx_ex",
    ".png": "image_ex", ".jpg": "image_ex", ".jpeg": "image_ex", ".gif": "image_ex",
    ".bmp": "image_ex", ".tif": "image_ex", ".tiff": "image_ex", ".webp": "image_ex",
    ".csv": "data_ex", ".tsv": "data_ex", ".json": "data_ex",
    ".html": "html_ex", ".htm": "html_ex", ".rtf": "html_ex",
    ".eml": "email_ex", ".msg": "email_ex",
    ".doc": "legacy_ex", ".xls": "legacy_ex", ".ppt": "legacy_ex",
}


def main(argv):
    if len(argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: extract.py <input> <out_dir> [--max-pages N]"}))
        return 2
    src, out_dir = argv[1], argv[2]
    max_pages = 0
    if "--max-pages" in argv:
        try:
            max_pages = int(argv[argv.index("--max-pages") + 1])
        except (ValueError, IndexError):
            max_pages = 0

    ext = os.path.splitext(src)[1].lower()
    module = EXTRACTORS.get(ext)
    if not module:
        print(json.dumps({"ok": False, "kind": "unsupported", "ext": ext,
                          "error": f"no extractor for '{ext}'",
                          "source": src.replace(os.sep, "/")}))
        return 0

    try:
        import importlib
        mod = importlib.import_module(f"extractors.{module}")
        # Some libraries (e.g. PyMuPDF) print notices to stdout; redirect stdout
        # to stderr during extraction so ONLY our JSON manifest lands on stdout.
        real_stdout = sys.stdout
        sys.stdout = sys.stderr
        try:
            result = mod.extract(src, out_dir, max_pages)
        finally:
            sys.stdout = real_stdout
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as e:
        import traceback
        print(json.dumps({
            "ok": False, "kind": ext.lstrip("."), "source": src.replace(os.sep, "/"),
            "error": f"{type(e).__name__}: {e}",
            "trace": traceback.format_exc()[-1500:],
        }, ensure_ascii=False))
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
