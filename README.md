# Vault Librarian

Web interface for the Bobrick OT knowledge base: chat with an AI librarian agent (Claude Agent SDK), drag-and-drop file ingestion, and an interactive wikilink graph with a note viewer/editor. Runs locally at `http://localhost:4747`.

Sister repo: [Obsidian-knowledge-base](https://github.com/derrodbobrick/Obsidian-knowledge-base) — the vault itself, plus the OT Dashboard app (`localhost:4800`).

## Set up a new Windows machine / VM

1. Download `setup.cmd` and `setup.ps1` from this repo (or clone it).
2. Double-click **`setup.cmd`**.

The installer uses winget to install Git, Node.js LTS, Python 3, Obsidian, Claude Code, and LibreOffice (skipping anything already present), clones both repos into `%USERPROFILE%\Bobrick`, installs app dependencies and the Python extraction libraries (`scripts/requirements.txt`), sets `VAULT_PATH`, and drops `Start Vault Librarian.cmd` / `Start OT Dashboard.cmd` start scripts. It is safe to re-run — existing clones are pulled instead.

## File ingestion pipeline

Dropped files are extracted server-side into a rich, layout-aware bundle the librarian agent can understand — text/structure **plus a full-page image render of every page** so the agent visually reads layouts, charts, graphs, and tables, not just words. Supported formats: PDF, Excel (`.xlsx/.xlsm`, with merged cells, fill-colour → RAG status, formulas, comments, charts), Word (`.docx`), PowerPoint (`.pptx`), images (`.png/.jpg/…` via vision + optional OCR), `.csv/.tsv` (schema profile), `.json` (structure summary), `.html`, `.rtf`, emails (`.eml/.msg`, attachments re-ingested), and legacy `.doc/.xls/.ppt` (via LibreOffice). The engine lives in `scripts/extract.py` + `scripts/extractors/`; page rendering for Office formats needs LibreOffice (`soffice`) and degrades gracefully to text-only if it is absent.

Options: `setup.cmd -BaseDir C:\Bobrick` chooses the install location (keep it outside OneDrive — git is the sync mechanism between devices); `setup.cmd -DryRun` prints what would happen without changing anything.

One-time manual steps after install: run `claude` once to log in (the chat agent runs on your Claude account), open the vault folder in Obsidian, and sign into GitHub when the first `git push` prompts.

## Manual start (already set up)

```
set VAULT_PATH=C:\path\to\Obsidian-knowledge-base
node server.js
```

Environment: `VAULT_PATH` (vault location), `PORT` (default 4747), `PYTHON` (Python executable, default `python`). Requires Node 18+, Python 3 with the `scripts/requirements.txt` libraries on PATH for file ingestion, LibreOffice for Office-document page rendering (optional but recommended), and a logged-in Claude Code installation for the chat agent.
