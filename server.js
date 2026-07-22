import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import os from "node:os";

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
// Chat: one librarian session PER client (browser tab), resumed across turns.
// A single global "edit lock" lets exactly one session change the vault at a
// time; every other session is read-only until it is released.
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 30_000; // a session with no heartbeat this long is dropped

// clientId -> { claudeSessionId, busy, activeQuery, lastSeen }
const sessions = new Map();
let editHolder = null; // clientId currently allowed to write, or null

const clientIdOf = (req) =>
  String(req.get("x-client-id") || req.body?.clientId || req.query?.id || "").trim();

function touchSession(clientId) {
  let s = sessions.get(clientId);
  if (!s) {
    s = { claudeSessionId: null, busy: false, activeQuery: null, lastSeen: 0 };
    sessions.set(clientId, s);
  }
  s.lastSeen = Date.now();
  return s;
}

function dropSession(clientId) {
  const s = sessions.get(clientId);
  if (s?.activeQuery?.interrupt) { try { s.activeQuery.interrupt(); } catch { /* gone */ } }
  if (editHolder === clientId) editHolder = null;
  sessions.delete(clientId);
}

// What a session is allowed to know about the edit lock.
const editStatus = (clientId) => ({
  editing: editHolder === clientId,
  lockedByOther: editHolder !== null && editHolder !== clientId,
});

// Evict sessions whose tab went away (heartbeat stopped), freeing the lock.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastSeen > SESSION_TTL_MS) dropSession(id);
}, 10_000).unref();

// Tools the librarian may use. Read-only sessions can answer questions and
// research, but cannot create, edit, move, or delete anything in the vault.
const READONLY_TOOLS = ["Read", "Glob", "Grep", "TodoWrite", "WebSearch", "WebFetch", "Task"];
const EDIT_TOOLS = [...READONLY_TOOLS, "Write", "Edit", "Bash(git *)", "Bash(obsidian *)"];

// Guard for endpoints that mutate the vault — only the edit-lock holder passes.
function requireEdit(req, res) {
  const clientId = clientIdOf(req);
  if (!clientId || editHolder !== clientId) {
    res.status(403).json({ error: "This session is read-only. Turn on Edit mode to make changes." });
    return false;
  }
  touchSession(clientId);
  return true;
}

app.post("/api/chat", async (req, res) => {
  const clientId = clientIdOf(req);
  if (!clientId) return res.status(400).json({ error: "missing client id" });
  const userMessage = (req.body?.message || "").trim();
  if (!userMessage) return res.status(400).json({ error: "empty message" });
  const session = touchSession(clientId);
  if (session.busy) return res.status(409).json({ error: "The librarian is still working on your previous request." });
  session.busy = true;

  const canEdit = editHolder === clientId;

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    // In read-only mode the write tools are withheld entirely; this note just
    // keeps the librarian from trying (and failing) to edit, so it explains
    // instead. The tool allow-list is the real enforcement.
    const prompt = canEdit
      ? userMessage
      : `${userMessage}\n\n[System: this session is READ-ONLY. Answer from the knowledge base, but do not create, edit, move, or delete any notes or files. If asked to make changes, explain that Edit mode must be enabled.]`;

    const q = query({
      prompt,
      options: {
        cwd: VAULT,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        // Auto-approve only the tools this session is allowed; everything else
        // is denied rather than prompting (there is no UI to answer).
        permissionMode: "dontAsk",
        allowedTools: canEdit ? EDIT_TOOLS : READONLY_TOOLS,
        maxTurns: 150,
        // Stream token-level deltas so the UI can render text as it arrives.
        includePartialMessages: true,
        ...(session.claudeSessionId ? { resume: session.claudeSessionId } : {}),
      },
    });
    session.activeQuery = q;

    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        session.claudeSessionId = msg.session_id || session.claudeSessionId;
        send({ kind: "session", id: session.claudeSessionId });
      } else if (msg.type === "stream_event") {
        // Token deltas for the top-level assistant only (subagents stay quiet);
        // the full "text" event that follows is the authoritative content.
        if (
          msg.parent_tool_use_id == null &&
          msg.event?.type === "content_block_delta" &&
          msg.event.delta?.type === "text_delta" &&
          msg.event.delta.text
        ) {
          send({ kind: "delta", text: msg.event.delta.text });
        }
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
        session.claudeSessionId = msg.session_id || session.claudeSessionId;
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
    session.busy = false;
    session.activeQuery = null;
    res.end();
  }
});

app.post("/api/stop", async (req, res) => {
  const s = sessions.get(clientIdOf(req));
  const q = s?.activeQuery;
  if (q && typeof q.interrupt === "function") {
    try { await q.interrupt(); } catch { /* already finished */ }
    return res.json({ ok: true });
  }
  res.json({ ok: false, error: "nothing running" });
});

app.post("/api/reset", (req, res) => {
  const clientId = clientIdOf(req);
  const s = clientId ? touchSession(clientId) : null;
  if (s) s.claudeSessionId = null;
  res.json({ ok: true });
});

// Heartbeat keeps a session alive and reports the current edit-lock state, so
// a waiting tab learns the moment the lock is released by whoever held it.
app.post("/api/heartbeat", (req, res) => {
  const clientId = clientIdOf(req);
  if (!clientId) return res.status(400).json({ error: "missing client id" });
  touchSession(clientId);
  res.json(editStatus(clientId));
});

// Claim (want:true) or release (want:false) the single edit lock.
app.post("/api/edit", (req, res) => {
  const clientId = clientIdOf(req);
  if (!clientId) return res.status(400).json({ error: "missing client id" });
  touchSession(clientId);
  if (req.body?.want) {
    if (editHolder === null || editHolder === clientId) editHolder = clientId;
  } else if (editHolder === clientId) {
    editHolder = null;
  }
  res.json(editStatus(clientId));
});

// Tab is closing (navigator.sendBeacon) — drop the session and free the lock.
app.post("/api/session/close", (req, res) => {
  const clientId = clientIdOf(req);
  if (clientId) dropSession(clientId);
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

// Pure-text formats the agent Reads directly — kept in Inbox/Uploads, no
// extraction needed (they are already readable and carry no hidden layout).
const PASSTHROUGH_EXTS = new Set([
  ".md", ".txt", ".yaml", ".yml", ".xml",
  ".js", ".ts", ".py", ".css", ".ini", ".toml", ".log", ".base", ".canvas",
]);
// Text-based but worth an extraction *profile* (schema, structure, samples);
// the original stays readable in Inbox/Uploads.
const TEXT_EXTRACT_EXTS = new Set([".csv", ".tsv", ".json", ".html", ".htm"]);
// Everything the Python extraction pipeline understands. Binary members are
// filed into Meta/Attachments; text members (above) stay in Inbox/Uploads.
const EXTRACT_EXTS = new Set([
  ".pdf", ".xlsx", ".xlsm", ".docx", ".pptx", ".doc", ".xls", ".ppt",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp",
  ".csv", ".tsv", ".json", ".html", ".htm", ".rtf", ".eml", ".msg",
]);

const PYTHON = process.env.PYTHON || "python";
const EXTRACT_SCRIPT = path.join(__dirname, "scripts", "extract.py");
// Extraction bundles (text + page renders + media) live OUTSIDE the vault so
// they never clutter the graph; the agent reads them by absolute path.
const EXTRACT_DIR = path.join(__dirname, "extractions");

// Run the extraction dispatcher on one file; returns the parsed JSON manifest.
async function runExtract(absSource, outDir) {
  const { stdout } = await execFileAsync(
    PYTHON, [EXTRACT_SCRIPT, absSource, outDir],
    { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }
  );
  return JSON.parse(stdout);
}

let extractSeq = 0;
function uniqueExtractDir(filename) {
  const base = path.basename(filename, path.extname(filename))
    .replace(/[^\w.-]+/g, "_").slice(0, 40) || "file";
  const dir = path.join(EXTRACT_DIR, `${Date.now()}-${extractSeq++}-${base}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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

// Email attachments come back as media files inside the email's bundle; feed
// each supported one back through the pipeline as its own bundle.
async function ingestEmailAttachments(manifest, bundles, warnings) {
  if (manifest.kind !== "email") return;
  for (const m of manifest.media || []) {
    const ext = path.extname(m.path).toLowerCase();
    if (!EXTRACT_EXTS.has(ext)) continue;
    try {
      const sub = await runExtract(m.path, uniqueExtractDir(path.basename(m.path)));
      if (sub.ok) {
        bundles.push({ originalName: path.basename(m.path), originalPath: null,
          viaEmail: manifest.source, ...sub });
      }
    } catch { /* best effort — the email body is already captured */ }
  }
}

// Deterministic server-side ingestion: file each upload, then run the Python
// extraction pipeline so the agent receives rich text + page renders + media it
// can Read, never needing shell access. Binaries land in Meta/Attachments;
// text-based files stay in Inbox/Uploads; every supported type also gets an
// extraction bundle in EXTRACT_DIR (outside the vault).
app.post("/api/upload", upload.array("files", 20), async (req, res) => {
  if (!requireEdit(req, res)) return;
  const attachmentsDir = path.join(VAULT, "Meta", "Attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });

  const kept = [];        // text files left in Inbox/Uploads
  const attachments = []; // binaries filed into Meta/Attachments
  const bundles = [];     // extraction bundles (text + page renders + media)
  const warnings = [];

  for (const f of req.files || []) {
    const ext = path.extname(f.filename).toLowerCase();
    const isText = PASSTHROUGH_EXTS.has(ext) || TEXT_EXTRACT_EXTS.has(ext);

    // Decide where the ORIGINAL lives.
    let originalAbs, originalRel;
    if (isText) {
      originalAbs = f.path;              // stays in Inbox/Uploads
      originalRel = rel(f.path);
      kept.push(originalRel);
    } else {
      const dest = uniquePath(attachmentsDir, f.filename);
      fs.renameSync(f.path, dest);       // binary → Meta/Attachments
      originalAbs = dest;
      originalRel = rel(dest);
      attachments.push(originalRel);
    }

    // Run the extraction pipeline where the format is supported.
    if (EXTRACT_EXTS.has(ext)) {
      try {
        const manifest = await runExtract(originalAbs, uniqueExtractDir(f.filename));
        if (manifest.ok) {
          bundles.push({ originalName: f.filename, originalPath: originalRel, ...manifest });
          for (const w of manifest.warnings || []) warnings.push(`${f.filename}: ${w}`);
          await ingestEmailAttachments(manifest, bundles, warnings);
        } else {
          warnings.push(`Could not extract ${f.filename}: ${manifest.error || "unknown error"}`);
        }
      } catch (err) {
        warnings.push(`Could not extract ${f.filename}: ${String(err?.message || err).slice(0, 200)}`);
      }
    }
  }

  res.json({ kept, attachments, bundles, warnings });
});

// prune extraction bundles (subdirectories) older than 7 days on startup
try {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const name of fs.existsSync(EXTRACT_DIR) ? fs.readdirSync(EXTRACT_DIR) : []) {
    const p = path.join(EXTRACT_DIR, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* skip */ }
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

// Structured task/event data for the project dashboards (Kanban, calendar, etc.)
app.get("/api/tasks", (req, res) => {
  try {
    const tasks = [];
    for (const file of walkMarkdown(VAULT)) {
      const fm = parseFrontmatter(fs.readFileSync(file, "utf-8"));
      if (fm.type !== "task" && fm.type !== "milestone" && fm.type !== "event") continue;
      tasks.push({
        name: path.basename(file, ".md"),
        path: rel(file),
        type: fm.type,
        status: fm.status || "todo",
        priority: fm.priority || "",
        due: fm.due || fm.date || "",
        scheduled: fm.scheduled || "",
        start: fm.start || "",
        completed: fm.completed || "",
        project: extractWikilinks(fm.project)[0] || "",
        parent: extractWikilinks(fm.parent)[0] || "",
        assignees: extractWikilinks(fm.assignee),
        dependsOn: extractWikilinks(fm["depends-on"]),
      });
    }
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ---------------------------------------------------------------------------
// File viewer: serve any vault file, and (for binary/office formats) a preview
// bundle of page renders + extracted text so it is viewable in the browser.
// ---------------------------------------------------------------------------
const VAULT_ROOT = path.resolve(VAULT);

// Resolve a file by vault-relative path, or by basename (attachments referenced
// as ![[name.ext]] carry only the basename). Prefers Meta/Attachments.
function resolveVaultFile({ path: relPath, name }) {
  if (relPath) {
    const abs = path.resolve(VAULT, String(relPath));
    if (abs.startsWith(VAULT_ROOT) && fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    return null;
  }
  if (name) {
    const target = String(name).toLowerCase();
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name)) { const r = walk(p); if (r) return r; } }
        else if (e.name.toLowerCase() === target) return p;
      }
      return null;
    };
    const att = path.join(VAULT, "Meta", "Attachments");
    return (fs.existsSync(att) && walk(att)) || walk(VAULT);
  }
  return null;
}

app.get("/api/file", (req, res) => {
  const abs = resolveVaultFile({ path: req.query.path, name: req.query.name });
  if (!abs) return res.status(404).json({ error: "file not found" });
  res.sendFile(abs);
});

// Render PNGs live in EXTRACT_DIR (outside the vault); serve them by absolute
// path, constrained to that directory.
app.get("/api/render", (req, res) => {
  const abs = path.resolve(String(req.query.f || ""));
  if (!abs.startsWith(path.resolve(EXTRACT_DIR))) return res.status(403).end();
  if (!fs.existsSync(abs)) return res.status(404).end();
  res.sendFile(abs);
});

const previewCache = new Map(); // `${abs}:${mtimeMs}` -> preview payload

app.get("/api/preview", async (req, res) => {
  const abs = resolveVaultFile({ path: req.query.path, name: req.query.name });
  if (!abs) return res.status(404).json({ error: "file not found" });
  const ext = path.extname(abs).toLowerCase();
  if (!EXTRACT_EXTS.has(ext)) return res.json({ kind: "none", pages: [], media: [], text: "" });
  const key = `${abs}:${fs.statSync(abs).mtimeMs}`;
  if (previewCache.has(key)) return res.json(previewCache.get(key));
  try {
    const manifest = await runExtract(abs, uniqueExtractDir(path.basename(abs)));
    const toUrl = (p) => "/api/render?f=" + encodeURIComponent(p);
    const out = {
      ok: !!manifest.ok, kind: manifest.kind || ext.slice(1), pageCount: manifest.pageCount || 0,
      pages: (manifest.pages || []).map(toUrl),
      media: (manifest.media || []).map((m) => toUrl(m.path)),
      meta: manifest.meta || {}, text: "",
    };
    try { out.text = fs.readFileSync(manifest.textFile, "utf-8"); } catch { /* no text */ }
    previewCache.set(key, out);
    res.json(out);
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
  if (!requireEdit(req, res)) return;
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
  if (!requireEdit(req, res)) return;
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
  if (!requireEdit(req, res)) return;
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

// Pull wikilink target names out of a frontmatter value (scalar or list form),
// e.g. `"[[A]]"` or `["[[A]]", "[[B]]"]` -> ["A","B"].
function extractWikilinks(val) {
  const out = [];
  if (!val) return out;
  for (const m of String(val).matchAll(/\[\[([^\]|#\n]+)/g)) out.push(m[1].trim());
  return out;
}

// Which relationship a PM frontmatter field expresses (drives edge coloring and
// the Project graph's cross-graph toggle).
const PM_FIELD_KIND = {
  project: "membership", parent: "membership",
  "depends-on": "dependency",
  assignee: "assignment", owner: "assignment",
};

// PM node types that belong to the Project graph (everything else is knowledge).
const PM_TYPES = new Set(["program", "project", "task", "milestone", "event"]);

function buildGraph() {
  // templates are scaffolding, not knowledge — keep them out of the graph
  const files = walkMarkdown(VAULT).filter(
    (f) => !path.relative(VAULT, f).startsWith(path.join("Meta", "Templates"))
  );
  const nodes = new Map(); // lowercase name -> node
  const links = [];
  const edgeKind = new Map(); // "src|tgt" (lowercase) -> relationship kind

  for (const file of files) {
    const name = path.basename(file, ".md");
    const text = fs.readFileSync(file, "utf-8");
    const fm = parseFrontmatter(text);
    const folder = path.relative(VAULT, path.dirname(file)).split(path.sep)[0] || "";
    const type = fm.type || "note";
    const node = { id: name, type, folder, exists: true, pm: PM_TYPES.has(type) };
    // Carry PM metadata for node styling (status color, priority size, overdue).
    for (const k of ["status", "priority", "due", "scheduled", "completed"]) {
      if (fm[k]) node[k] = fm[k];
    }
    nodes.set(name.toLowerCase(), node);
    // Remember which relationship each PM frontmatter edge expresses.
    for (const [field, kind] of Object.entries(PM_FIELD_KIND)) {
      for (const tgt of extractWikilinks(fm[field])) {
        edgeKind.set(name.toLowerCase() + "|" + tgt.toLowerCase(), kind);
      }
    }
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
        nodes.set(key, { id: target, type: "unresolved", folder: "", exists: false, pm: false });
      }
      const kind = edgeKind.get(source.toLowerCase() + "|" + key) || "link";
      // A "context" edge bridges a PM node and a knowledge node (R12) — the
      // link the cross-graph toggle shows/hides.
      const s = nodes.get(source.toLowerCase()), t = nodes.get(key);
      const crossGraph = !!(s && t && s.pm !== t.pm);
      links.push({ source, target: nodes.get(key).id, kind, cross: crossGraph });
    }
  }

  return { nodes: [...nodes.values()], links };
}

// Collect this machine's LAN IPv4 addresses so we can print reachable URLs.
function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}

// Bind on 0.0.0.0 so other devices on the same Wi-Fi/LAN can reach the app.
// NOTE: there is no authentication — anyone who can reach this URL can use the
// librarian (which spends your Claude account) and, in Edit mode, change files.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vault Librarian running:`);
  console.log(`  local:    http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  network:  http://${ip}:${PORT}`);
  console.log(`Vault: ${VAULT}`);
  console.log(`Open to the local network with NO password — only run this on a network you trust.`);
});
