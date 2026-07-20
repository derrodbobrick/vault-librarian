import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VAULT = process.env.VAULT_PATH ||
  "C:\\Users\\jderr\\OneDrive\\Desktop\\Obsidian Knowledge Base";
const PORT = process.env.PORT || 4747;

// Folders never shown in the graph or touched by uploads
const IGNORED_DIRS = new Set([".obsidian", ".claude", ".git", ".trash", "OT Dashboard"]);

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Chat: one librarian session, resumed across turns
// ---------------------------------------------------------------------------
let sessionId = null; // resume token for conversation continuity
let busy = false;

app.post("/api/chat", async (req, res) => {
  const userMessage = (req.body?.message || "").trim();
  if (!userMessage) return res.status(400).json({ error: "empty message" });
  if (busy) return res.status(409).json({ error: "The librarian is still working on the previous request." });
  busy = true;

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    const q = query({
      prompt: userMessage,
      options: {
        cwd: VAULT,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        // Auto-approve only the tools a vault librarian needs; everything
        // else is denied rather than prompting (there is no UI to answer).
        permissionMode: "dontAsk",
        allowedTools: [
          "Read", "Write", "Edit", "Glob", "Grep",
          "TodoWrite", "WebSearch", "WebFetch", "Task",
          "Bash(git *)", "Bash(obsidian *)",
        ],
        maxTurns: 150,
        ...(sessionId ? { resume: sessionId } : {}),
      },
    });

    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id || sessionId;
        send({ kind: "session", id: sessionId });
      } else if (msg.type === "assistant") {
        const blocks = msg.message?.content || [];
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            send({ kind: "text", text: block.text });
          } else if (block.type === "tool_use") {
            send({ kind: "tool", name: block.name, input: summarizeToolInput(block.name, block.input) });
          }
        }
      } else if (msg.type === "result") {
        sessionId = msg.session_id || sessionId;
        send({
          kind: "result",
          ok: msg.subtype === "success",
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          error: msg.subtype === "success" ? undefined : msg.subtype,
        });
      }
    }
  } catch (err) {
    send({ kind: "error", message: String(err?.message || err) });
  } finally {
    busy = false;
    res.end();
  }
});

app.post("/api/reset", (req, res) => {
  sessionId = null;
  res.json({ ok: true });
});

function summarizeToolInput(name, input) {
  if (!input) return "";
  const s =
    input.file_path || input.path || input.pattern || input.command ||
    input.url || input.query || input.description || "";
  return String(s).slice(0, 120);
}

// ---------------------------------------------------------------------------
// Upload: files land in Inbox/Uploads, then the UI hands them to the agent
// ---------------------------------------------------------------------------
const uploadDir = path.join(VAULT, "Inbox", "Uploads");
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // keep the original name; suffix on collision
    const safe = path.basename(file.originalname).replace(/[<>:"/\\|?*]/g, "_");
    let name = safe;
    let i = 1;
    while (fs.existsSync(path.join(uploadDir, name))) {
      const ext = path.extname(safe);
      name = `${path.basename(safe, ext)} (${i++})${ext}`;
    }
    cb(null, name);
  },
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// Text formats the agent can Read directly — these stay in Inbox/Uploads.
const TEXT_EXTS = new Set([
  ".md", ".txt", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".html",
  ".js", ".ts", ".py", ".css", ".ini", ".toml", ".log", ".base", ".canvas",
]);
// Binary formats the agent's Read tool can still open at their filed location.
const XLSX_EXTS = new Set([".xlsx", ".xlsm"]);

const rel = (abs) => path.relative(VAULT, abs).split(path.sep).join("/");

function uniquePath(dir, name) {
  let out = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(out)) {
    const ext = path.extname(name);
    out = path.join(dir, `${path.basename(name, ext)} (${i++})${ext}`);
  }
  return out;
}

// Binary handling is done here in deterministic server code, so the agent
// never needs shell access: binaries are filed into Meta/Attachments at
// upload time, and spreadsheets are pre-extracted to text the agent can Read.
app.post("/api/upload", upload.array("files", 20), async (req, res) => {
  const attachmentsDir = path.join(VAULT, "Meta", "Attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const kept = [];        // text files left in Inbox/Uploads
  const attachments = []; // binaries filed into Meta/Attachments
  const extracted = [];   // text extractions of binaries, in Inbox/Uploads
  const warnings = [];

  for (const f of req.files || []) {
    const ext = path.extname(f.filename).toLowerCase();
    if (TEXT_EXTS.has(ext)) {
      kept.push(rel(f.path));
      continue;
    }

    // binary → file it as an attachment
    const dest = uniquePath(attachmentsDir, f.filename);
    fs.renameSync(f.path, dest);
    attachments.push(rel(dest));

    if (XLSX_EXTS.has(ext)) {
      // extractions live OUTSIDE the vault (agent reads them by absolute
      // path) so they never clutter the graph or the inbox
      fs.mkdirSync(EXTRACT_DIR, { recursive: true });
      const outPath = uniquePath(EXTRACT_DIR, path.basename(f.filename, ext) + ".extracted.txt");
      try {
        await execFileAsync("python", [
          path.join(__dirname, "scripts", "extract_xlsx.py"), dest, outPath,
        ], { timeout: 60000 });
        extracted.push(outPath);
      } catch (err) {
        warnings.push(`Could not extract ${f.filename}: ${String(err?.message || err).slice(0, 200)}`);
      }
    }
  }

  res.json({ kept, attachments, extracted, warnings });
});

const EXTRACT_DIR = path.join(__dirname, "extractions");

// prune extraction files older than 7 days on startup
try {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const name of fs.existsSync(EXTRACT_DIR) ? fs.readdirSync(EXTRACT_DIR) : []) {
    const p = path.join(EXTRACT_DIR, name);
    if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
  }
} catch { /* best effort */ }

// ---------------------------------------------------------------------------
// Graph: parse the vault's wikilinks + frontmatter
// ---------------------------------------------------------------------------
app.get("/api/graph", (req, res) => {
  try {
    res.json(buildGraph());
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get("/api/note", (req, res) => {
  const name = String(req.query.name || "");
  const file = findNoteByName(name);
  if (!file) return res.status(404).json({ error: "note not found" });
  res.json({
    name,
    path: path.relative(VAULT, file).split(path.sep).join("/"),
    markdown: fs.readFileSync(file, "utf-8"),
  });
});

// ---------------------------------------------------------------------------
// Manual editing: save a note, add/remove connections (both endpoints)
// ---------------------------------------------------------------------------
const clean = (s, max) => String(s ?? "").trim().slice(0, max);

function appendActivity(entry) {
  try {
    const logPath = path.join(VAULT, "Meta", "Activity Log.md");
    let t = fs.readFileSync(logPath, "utf-8");
    const today = new Date().toISOString().slice(0, 10);
    const header = `## ${today}`;
    const line = `- ${entry}`;
    if (t.includes(header)) {
      t = t.replace(header + "\n\n", header + "\n\n" + line + "\n");
    } else {
      // insert a new dated section after the intro (before the first ## )
      const idx = t.search(/\n## /);
      t = idx === -1 ? t + `\n${header}\n\n${line}\n`
        : t.slice(0, idx) + `\n${header}\n\n${line}\n` + t.slice(idx);
    }
    fs.writeFileSync(logPath, t);
  } catch { /* best effort */ }
}

app.put("/api/note", (req, res) => {
  const name = String(req.body?.name || "");
  const markdown = String(req.body?.markdown ?? "");
  const file = findNoteByName(name);
  if (!file) return res.status(404).json({ error: "note not found" });
  if (!markdown.trim()) return res.status(400).json({ error: "refusing to save empty note" });
  fs.writeFileSync(file, markdown.endsWith("\n") ? markdown : markdown + "\n");
  appendActivity(`Manually edited the note "${name}" via the Vault Librarian UI.`);
  res.json({ ok: true });
});

function addRelatedBullet(file, target, reason) {
  let t = fs.readFileSync(file, "utf-8");
  const bullet = `- [[${target}]] — ${reason}`;
  const idx = t.indexOf("## Related");
  if (idx !== -1) {
    const rest = t.slice(idx + 3);
    const nxt = rest.search(/\n## /);
    const insertAt = nxt === -1 ? t.length : idx + 3 + nxt;
    t = t.slice(0, insertAt).replace(/\n*$/, "\n") + bullet + "\n" + t.slice(insertAt).replace(/^\n*/, nxt === -1 ? "" : "\n");
  } else {
    t = t.replace(/\n*$/, "\n") + `\n## Related\n\n${bullet}\n`;
  }
  fs.writeFileSync(file, t);
}

function removeLinks(file, target) {
  let t = fs.readFileSync(file, "utf-8");
  const esc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // drop whole Related bullets pointing at target
  t = t.replace(new RegExp(`^\\s*- \\[\\[${esc}(?:#[^\\]|\\n]*)?(?:\\|[^\\]\\n]*)?\\]\\][^\\n]*\\n`, "gm"), "");
  // de-link inline mentions (keep display text)
  t = t.replace(new RegExp(`\\[\\[${esc}(?:#[^\\]|\\n]*)?\\|([^\\]\\n]*)\\]\\]`, "g"), "$1");
  t = t.replace(new RegExp(`\\[\\[${esc}(?:#[^\\]|\\n]*)?\\]\\]`, "g"), target);
  fs.writeFileSync(file, t);
}

app.post("/api/link", (req, res) => {
  const { from, to, reason } = req.body || {};
  const fileA = findNoteByName(String(from || ""));
  const fileB = findNoteByName(String(to || ""));
  if (!fileA || !fileB) return res.status(404).json({ error: "note not found" });
  const why = clean(reason, 300) || "connected via the Vault Librarian UI";
  addRelatedBullet(fileA, to, why);
  addRelatedBullet(fileB, from, why);
  appendActivity(`Connected "${from}" and "${to}" via the UI — ${why}.`);
  res.json({ ok: true });
});

app.delete("/api/link", (req, res) => {
  const { from, to } = req.body || {};
  const fileA = findNoteByName(String(from || ""));
  const fileB = findNoteByName(String(to || ""));
  if (!fileA || !fileB) return res.status(404).json({ error: "note not found" });
  removeLinks(fileA, to);
  removeLinks(fileB, from);
  appendActivity(`Disconnected "${from}" and "${to}" via the UI (mentions kept as plain text).`);
  res.json({ ok: true });
});

function walkMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) walkMarkdown(path.join(dir, entry.name), out);
    } else if (entry.name.toLowerCase().endsWith(".md") && entry.name !== "CLAUDE.md") {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function findNoteByName(name) {
  const target = name.toLowerCase();
  for (const file of walkMarkdown(VAULT)) {
    if (path.basename(file, ".md").toLowerCase() === target) return file;
  }
  return null;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
  }
  return fm;
}

function buildGraph() {
  // templates are scaffolding, not knowledge — keep them out of the graph
  const files = walkMarkdown(VAULT).filter(
    (f) => !path.relative(VAULT, f).startsWith(path.join("Meta", "Templates"))
  );
  const nodes = new Map(); // lowercase name -> node
  const links = [];

  for (const file of files) {
    const name = path.basename(file, ".md");
    const text = fs.readFileSync(file, "utf-8");
    const fm = parseFrontmatter(text);
    const folder = path.relative(VAULT, path.dirname(file)).split(path.sep)[0] || "";
    nodes.set(name.toLowerCase(), {
      id: name,
      type: fm.type || "note",
      folder,
      exists: true,
    });
  }

  for (const file of files) {
    const source = path.basename(file, ".md");
    // like Obsidian: wikilinks inside code fences / inline code don't count
    const text = fs.readFileSync(file, "utf-8")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`\n]*`/g, "");
    const seen = new Set();
    // [[Target]], [[Target|alias]], [[Target#heading]]
    for (const m of text.matchAll(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) {
      let target = m[1].trim();
      if (!target) continue;
      if (target.includes(".")) {
        // links carrying a file extension (.base, .png, ...) — only follow .md
        if (!target.toLowerCase().endsWith(".md")) continue;
        target = target.slice(0, -3);
      }
      const key = target.toLowerCase();
      if (key === source.toLowerCase() || seen.has(key)) continue;
      seen.add(key);
      if (!nodes.has(key)) {
        nodes.set(key, { id: target, type: "unresolved", folder: "", exists: false });
      }
      links.push({ source, target: nodes.get(key).id });
    }
  }

  return { nodes: [...nodes.values()], links };
}

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Vault Librarian running at http://localhost:${PORT}`);
  console.log(`Vault: ${VAULT}`);
});
