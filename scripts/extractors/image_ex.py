"""Image (.png/.jpg/.gif/.bmp/.tiff/.webp) metadata + optional OCR.

The image itself is read visually by the agent (Claude vision) at its attachment
path — that is the best reader for charts/graphs/diagrams. Here we add the
context vision can miss: dimensions, EXIF, and an OCR text layer when a local
Tesseract is available (useful for dense screenshots).
"""
from __future__ import annotations

from .common import Bundle, human_size
import os


def _try_ocr(path: str) -> str:
    try:
        import pytesseract
        from PIL import Image
        return pytesseract.image_to_string(Image.open(path)).strip()
    except Exception:
        return ""


def extract(src: str, out_dir: str, max_pages: int = 0) -> dict:
    from PIL import Image
    from PIL.ExifTags import TAGS

    b = Bundle(src, out_dir, "image")
    b.add(f"# Image: {os.path.basename(src)}")
    try:
        im = Image.open(src)
        b.meta = {"width": im.width, "height": im.height, "mode": im.mode, "format": im.format}
        b.add(f"Dimensions: {im.width} × {im.height}px  ·  {im.mode}  ·  "
              f"{im.format}  ·  {human_size(os.path.getsize(src))}")
        exif = getattr(im, "_getexif", lambda: None)()
        if exif:
            useful = {}
            for tag_id, val in exif.items():
                tag = TAGS.get(tag_id, tag_id)
                if tag in ("DateTimeOriginal", "Make", "Model", "Software",
                           "ImageDescription", "Artist", "GPSInfo", "Orientation"):
                    useful[str(tag)] = str(val)[:120]
            if useful:
                b.meta["exif"] = useful
                b.add("EXIF: " + ", ".join(f"{k}={v}" for k, v in useful.items()))
    except Exception as e:
        b.warn(f"could not open image: {e}")

    ocr = _try_ocr(src)
    if ocr:
        b.meta["ocrChars"] = len(ocr)
        b.heading("OCR text (auto-transcribed — verify against the image)", 2)
        b.add(ocr)
    else:
        b.add("", "> View the image directly with the Read tool to interpret any "
              "charts, diagrams, or text it contains.")

    return b.result()
