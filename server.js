import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VAULT = process.env.VAULT_PATH ||
  "C:\\Users\\jderr\\OneDrive\\Desktop\\Obsidian Knowledge Base";
const PORT = process.env.PORT || 4747;

// Folders never shown in the graph or touched by uploads
const IGNORED_DIRS = new Set([".obsidian", ".claude", ".git", ".trash"]);

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

app.post("/api/upload", upload.array("files", 20), (req, res) => {
  const saved = (req.files || []).map((f) =>
    path.relative(VAULT, f.path).split(path.sep).join("/")
  );
  res.json({ saved });
});

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
