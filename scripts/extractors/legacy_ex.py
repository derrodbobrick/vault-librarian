"""Legacy binary Office formats (.doc/.xls/.ppt) via LibreOffice conversion.

These pre-2007 formats aren't readable by python-docx/openpyxl/python-pptx, so we
convert them to the modern equivalent with LibreOffice and delegate to the modern
extractor. Requires LibreOffice; degrades to a warning if it is absent.
"""
from __future__ import annotations

import glob
import os
import shutil
import subprocess
import tempfile

from .common import Bundle
from . import render

_TARGET = {".doc": ("docx", "docx_ex"), ".xls": ("xlsx", "xlsx_ex"), ".ppt": ("pptx", "pptx_ex")}


def extract(src: str, out_dir: str, max_pages: int = 0) -> dict:
    ext = os.path.splitext(src)[1].lower()
    target_ext, module = _TARGET[ext]

    soffice = render.find_soffice()
    if not soffice:
        b = Bundle(src, out_dir, "legacy")
        b.add(f"# Legacy Office file: {os.path.basename(src)}")
        b.warn("LibreOffice not found — cannot convert legacy .doc/.xls/.ppt. "
               "Install LibreOffice to extract these.")
        b.add("*(LibreOffice required to read this legacy format — not installed.)*")
        return b.result()

    tmp = tempfile.mkdtemp(prefix="vl_legacy_")
    profile = os.path.join(tmp, "profile")
    try:
        subprocess.run(
            [soffice, "--headless", "--norestore", "--nolockcheck",
             f"-env:UserInstallation=file:///{profile.replace(os.sep, '/')}",
             "--convert-to", target_ext, "--outdir", tmp, src],
            timeout=render.SOFFICE_TIMEOUT, capture_output=True,
        )
        converted = glob.glob(os.path.join(tmp, f"*.{target_ext}"))
        if not converted:
            b = Bundle(src, out_dir, "legacy")
            b.add(f"# Legacy Office file: {os.path.basename(src)}")
            b.warn("LibreOffice conversion produced no output.")
            return b.result()

        import importlib
        mod = importlib.import_module(f".{module}", package="extractors")
        result = mod.extract(converted[0], out_dir, max_pages)
        # relabel the source back to the original legacy file
        result["source"] = src.replace(os.sep, "/")
        result["kind"] = "legacy-" + result.get("kind", "")
        return result
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
