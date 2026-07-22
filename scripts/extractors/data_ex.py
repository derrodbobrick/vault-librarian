"""Tabular/structured data profiling for .csv/.tsv and .json.

These are already plain text the agent can Read, but large files are noisy. We
add a compact *profile* (schema, types, row counts, samples) so the agent grasps
the shape and intent without wading through thousands of rows.
"""
from __future__ import annotations

import csv
import io
import json
import os

from .common import Bundle

SAMPLE_ROWS = 20
MAX_PROFILE_BYTES = 20 * 1024 * 1024


def _infer_type(values) -> str:
    seen = set()
    for v in values:
        v = (v or "").strip()
        if v == "":
            continue
        try:
            int(v); seen.add("int"); continue
        except ValueError:
            pass
        try:
            float(v); seen.add("float"); continue
        except ValueError:
            pass
        if v.lower() in ("true", "false", "yes", "no"):
            seen.add("bool"); continue
        seen.add("str")
    if not seen:
        return "empty"
    if seen == {"int"}:
        return "int"
    if seen <= {"int", "float"}:
        return "float"
    if seen == {"bool"}:
        return "bool"
    return "str"


def _extract_csv(src: str, b: Bundle) -> None:
    delim = "\t" if src.lower().endswith(".tsv") else ","
    with open(src, "r", encoding="utf-8-sig", errors="replace", newline="") as f:
        sample = f.read(65536)
        f.seek(0)
        try:
            delim = csv.Sniffer().sniff(sample, delimiters=",\t;|").delimiter
        except Exception:
            pass
        reader = csv.reader(f, delimiter=delim)
        rows = list(reader)
    if not rows:
        b.add("*(empty file)*")
        return
    header = rows[0]
    body = rows[1:]
    b.meta = {"columns": len(header), "rows": len(body), "delimiter": delim}
    b.add(f"# Tabular data: {os.path.basename(src)}")
    b.add(f"{len(body)} rows × {len(header)} columns  ·  delimiter `{delim}`")
    b.heading("Columns (name — inferred type)", 2)
    for ci, col in enumerate(header):
        col_vals = [r[ci] if ci < len(r) else "" for r in body[:2000]]
        b.add(f"- {col or f'(col {ci+1})'} — {_infer_type(col_vals)}")
    b.heading(f"First {min(SAMPLE_ROWS, len(body))} rows", 2)
    b.add("| " + " | ".join(header) + " |")
    b.add("| " + " | ".join(["---"] * len(header)) + " |")
    for r in body[:SAMPLE_ROWS]:
        b.add("| " + " | ".join((c or "").replace("\n", " ").replace("|", "/") for c in r) + " |")
    if len(body) > SAMPLE_ROWS:
        b.add(f"", f"… {len(body) - SAMPLE_ROWS} more rows in the original file.")


def _summarize_json(node, depth=0, max_depth=4):
    if depth >= max_depth:
        return "…"
    if isinstance(node, dict):
        return {k: _summarize_json(v, depth + 1, max_depth) for k, v in list(node.items())[:40]}
    if isinstance(node, list):
        if not node:
            return "[] (empty array)"
        return [f"array[{len(node)}] of:", _summarize_json(node[0], depth + 1, max_depth)]
    return type(node).__name__


def _extract_json(src: str, b: Bundle) -> None:
    b.add(f"# JSON: {os.path.basename(src)}")
    try:
        with open(src, "r", encoding="utf-8", errors="replace") as f:
            data = json.load(f)
    except Exception as e:
        b.warn(f"invalid JSON: {e}")
        b.add(f"*(could not parse as JSON: {e})*")
        return
    kind = "array" if isinstance(data, list) else "object" if isinstance(data, dict) else type(data).__name__
    b.meta = {"root": kind}
    if isinstance(data, list):
        b.meta["length"] = len(data)
        b.add(f"Root: array of {len(data)} items")
    elif isinstance(data, dict):
        b.meta["keys"] = list(data.keys())[:60]
        b.add(f"Root: object with {len(data)} keys")
    b.heading("Structure (shape summary)", 2)
    b.add("```json")
    b.add(json.dumps(_summarize_json(data), indent=2, ensure_ascii=False)[:8000])
    b.add("```")
    b.heading("Sample (first ~4 KB of pretty-printed content)", 2)
    b.add("```json")
    b.add(json.dumps(data, indent=2, ensure_ascii=False)[:4000])
    b.add("```")


def extract(src: str, out_dir: str, max_pages: int = 0) -> dict:
    ext = os.path.splitext(src)[1].lower()
    kind = "json" if ext == ".json" else "table"
    b = Bundle(src, out_dir, kind)
    if os.path.getsize(src) > MAX_PROFILE_BYTES:
        b.warn("file larger than 20 MB — profiled from the head only")
    if ext == ".json":
        _extract_json(src, b)
    else:
        _extract_csv(src, b)
    return b.result()
