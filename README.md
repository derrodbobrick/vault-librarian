# Vault Librarian

Web interface for the Bobrick OT knowledge base: chat with an AI librarian agent (Claude Agent SDK), drag-and-drop file ingestion, and an interactive wikilink graph with a note viewer/editor. Runs locally at `http://localhost:4747`.

Sister repo: [Obsidian-knowledge-base](https://github.com/derrodbobrick/Obsidian-knowledge-base) — the vault itself, plus the OT Dashboard app (`localhost:4800`).

## Set up a new Windows machine / VM

1. Download `setup.cmd` and `setup.ps1` from this repo (or clone it).
2. Double-click **`setup.cmd`**.

The installer uses winget to install Git, Node.js LTS, Python 3, Obsidian, and Claude Code (skipping anything already present), clones both repos into `%USERPROFILE%\Bobrick`, installs app dependencies and `openpyxl`, sets `VAULT_PATH`, and drops `Start Vault Librarian.cmd` / `Start OT Dashboard.cmd` start scripts. It is safe to re-run — existing clones are pulled instead.

Options: `setup.cmd -BaseDir C:\Bobrick` chooses the install location (keep it outside OneDrive — git is the sync mechanism between devices); `setup.cmd -DryRun` prints what would happen without changing anything.

One-time manual steps after install: run `claude` once to log in (the chat agent runs on your Claude account), open the vault folder in Obsidian, and sign into GitHub when the first `git push` prompts.

## Manual start (already set up)

```
set VAULT_PATH=C:\path\to\Obsidian-knowledge-base
node server.js
```

Environment: `VAULT_PATH` (vault location), `PORT` (default 4747). Requires Node 18+, Python 3 with `openpyxl` on PATH for spreadsheet uploads, and a logged-in Claude Code installation for the chat agent.
