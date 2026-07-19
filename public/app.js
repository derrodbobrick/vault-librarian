/* Vault Librarian front-end: chat + drag-drop + graph */

const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const inputEl = $("#input");

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
let sending = false;

function addUserMsg(text) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollChat();
}

function addAssistantMsg(markdown) {
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.innerHTML = marked.parse(markdown);
  messagesEl.appendChild(div);
  scrollChat();
  return div;
}

function addToolChip(name, input) {
  const div = document.createElement("div");
  div.className = "tool-chip";
  div.innerHTML = `<b>${escapeHtml(name)}</b> <span>${escapeHtml(input || "")}</span>`;
  messagesEl.appendChild(div);
  scrollChat();
}

function addStatus(text, isError = false) {
  const div = document.createElement("div");
  div.className = "status-line" + (isError ? " error" : "");
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollChat();
}

function scrollChat() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function sendMessage(text) {
  if (sending || !text.trim()) return;
  sending = true;
  addUserMsg(text);

  const thinking = document.createElement("div");
  thinking.className = "thinking";
  thinking.textContent = "The librarian is working";
  messagesEl.appendChild(thinking);
  scrollChat();

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });

    if (!resp.ok && resp.headers.get("content-type")?.includes("json")) {
      const err = await resp.json();
      addStatus(err.error || `Error ${resp.status}`, true);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let vaultChanged = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }

        if (evt.kind === "text") {
          addAssistantMsg(evt.text);
        } else if (evt.kind === "tool") {
          addToolChip(evt.name, evt.input);
          if (["Write", "Edit", "Bash"].includes(evt.name)) vaultChanged = true;
        } else if (evt.kind === "result") {
          const cost = evt.costUsd != null ? ` · $${evt.costUsd.toFixed(4)}` : "";
          const secs = evt.durationMs != null ? ` · ${(evt.durationMs / 1000).toFixed(1)}s` : "";
          addStatus(evt.ok ? `done${secs}${cost}` : `stopped: ${evt.error}`, !evt.ok);
        } else if (evt.kind === "error") {
          addStatus(evt.message, true);
        }
      }
    }

    if (vaultChanged) loadGraph(); // refresh after edits
  } catch (err) {
    addStatus("Connection error: " + err.message, true);
  } finally {
    thinking.remove();
    sending = false;
  }
}

$("#send-btn").addEventListener("click", () => {
  const text = inputEl.value;
  inputEl.value = "";
  sendMessage(text);
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const text = inputEl.value;
    inputEl.value = "";
    sendMessage(text);
  }
});
$("#reset-btn").addEventListener("click", async () => {
  await fetch("/api/reset", { method: "POST" });
  messagesEl.innerHTML = "";
  addStatus("new conversation started");
});

// ---------------------------------------------------------------------------
// Drag & drop → upload dialog → hand off to the agent
// ---------------------------------------------------------------------------
const overlay = $("#drop-overlay");
const dialog = $("#upload-dialog");
let pendingFiles = [];
let dragDepth = 0;

window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (e.dataTransfer?.types?.includes("Files")) {
    dragDepth++;
    overlay.classList.remove("hidden");
  }
});
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; overlay.classList.add("hidden"); }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.classList.add("hidden");
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  pendingFiles = files;
  const list = $("#upload-list");
  list.innerHTML = "";
  for (const f of files) {
    const li = document.createElement("li");
    li.textContent = `${f.name} (${formatSize(f.size)})`;
    list.appendChild(li);
  }
  $("#upload-desc").value = "";
  dialog.showModal();
});

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

$("#upload-cancel").addEventListener("click", () => { pendingFiles = []; dialog.close(); });

$("#upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  dialog.close();
  const desc = $("#upload-desc").value.trim();
  const files = pendingFiles;
  pendingFiles = [];
  if (!files.length) return;

  addStatus(`uploading ${files.length} file(s)…`);
  const form = new FormData();
  for (const f of files) form.append("files", f);

  try {
    const resp = await fetch("/api/upload", { method: "POST", body: form });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.status);

    const lines = [];
    if (data.kept?.length)
      lines.push(`Text files in Inbox/Uploads (read these directly):\n${data.kept.map((p) => `- ${p}`).join("\n")}`);
    if (data.attachments?.length)
      lines.push(`Binary files already filed into Meta/Attachments (do NOT move them):\n${data.attachments.map((p) => `- ${p}`).join("\n")}`);
    if (data.extracted?.length)
      lines.push(`Spreadsheet contents pre-extracted to text at these absolute paths (Read them for the sheet data):\n${data.extracted.map((p) => `- ${p}`).join("\n")}`);
    if (data.warnings?.length)
      lines.push(`Warnings:\n${data.warnings.map((w) => `- ${w}`).join("\n")}`);

    let msg = `I just dropped file(s) into the vault.\n\n${lines.join("\n\n")}\n\n`;
    if (desc) msg += `About these files / where they should go: ${desc}\n\n`;
    msg += `Please process them as the librarian: read the content (PDFs and images can be Read at their ` +
      `attachment path; spreadsheets via the extracted .txt), write or update markdown notes documenting ` +
      `the knowledge with proper frontmatter and [[wikilinks]] (embed attachments with ![[filename]]), ` +
      `and link the new notes into the relevant hub (program note, Smart Wiki, or org entity). Summarize what you did.`;
    sendMessage(msg);
  } catch (err) {
    addStatus("Upload failed: " + err.message, true);
  }
});

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------
const TYPE_COLORS = {
  moc: "#ffb74d",
  program: "#ffa726",
  project: "#7c5cff",
  area: "#4dd0e1",
  resource: "#4fc3f7",
  daily: "#9575cd",
  note: "#90a4ae",
  template: "#546e7a",
  division: "#ef5350",
  department: "#ec407a",
  "work-center": "#f57f17",
  cell: "#ffee58",
  machine: "#78909c",
  hardware: "#8d6e63",
  software: "#66bb6a",
  server: "#26a69a",
  website: "#42a5f5",
  unresolved: "#5c6370",
};

let graph = null;
let graphData = { nodes: [], links: [] };

async function loadGraph() {
  const resp = await fetch("/api/graph");
  graphData = await resp.json();
  if (!graph) initGraph();
  graph.graphData(graphData);
  renderLegend();
}

function initGraph() {
  const el = $("#graph");
  graph = ForceGraph()(el)
    .backgroundColor("#12141a")
    .nodeId("id")
    .nodeLabel((n) => `${n.id}${n.exists ? "" : " (unresolved)"}`)
    .nodeVal((n) => (n.type === "moc" || n.type === "program" ? 6 : 3))
    .nodeCanvasObject((node, ctx, globalScale) => {
      const r = node.type === "moc" || node.type === "program" ? 7 : node.exists ? 4.5 : 3;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = TYPE_COLORS[node.type] || TYPE_COLORS.note;
      if (!node.exists) { ctx.globalAlpha = 0.45; }
      ctx.fill();
      ctx.globalAlpha = 1;
      if (globalScale > 1.2) {
        ctx.font = `${Math.max(10 / globalScale, 2.5)}px Segoe UI, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = node.exists ? "#c9cfdd" : "#6b7285";
        ctx.fillText(node.id, node.x, node.y + r + 1.5);
      }
    })
    .linkColor(() => "#3a4152")
    .linkWidth(1)
    .onNodeClick((node) => { if (node.exists) openNote(node.id); })
    .width(el.clientWidth)
    .height(el.clientHeight);

  window.addEventListener("resize", () => {
    graph.width(el.clientWidth).height(el.clientHeight);
  });
}

function renderLegend() {
  const present = new Set(graphData.nodes.map((n) => n.type));
  const legend = $("#legend");
  legend.innerHTML = "";
  for (const [type, color] of Object.entries(TYPE_COLORS)) {
    if (!present.has(type)) continue;
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `<span class="legend-dot" style="background:${color}"></span>${type}`;
    legend.appendChild(item);
  }
}

$("#refresh-graph").addEventListener("click", loadGraph);

$("#graph-search").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = e.target.value.trim().toLowerCase();
  if (!q) return;
  const node = graphData.nodes.find((n) => n.id.toLowerCase().includes(q));
  if (node) {
    graph.centerAt(node.x, node.y, 600);
    graph.zoom(4, 600);
    if (node.exists) openNote(node.id);
  }
});

// ---------------------------------------------------------------------------
// Note viewer
// ---------------------------------------------------------------------------
async function openNote(name) {
  const resp = await fetch(`/api/note?name=${encodeURIComponent(name)}`);
  if (!resp.ok) return;
  const data = await resp.json();

  $("#note-title").textContent = data.name;
  $("#note-path").textContent = data.path;

  // split off frontmatter for a nicer header
  let md = data.markdown;
  let fmHtml = "";
  const fmMatch = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fmMatch) {
    md = md.slice(fmMatch[0].length);
    const pairs = fmMatch[1].split(/\r?\n/)
      .map((l) => l.match(/^(\w[\w-]*):\s*(.*)$/))
      .filter(Boolean)
      .map((m) => `<span><b>${escapeHtml(m[1])}</b>: ${escapeHtml(m[2])}</span>`);
    fmHtml = `<div class="frontmatter">${pairs.join("")}</div>`;
  }

  // convert [[wikilinks]] to clickable spans before markdown rendering
  const names = new Set(graphData.nodes.filter((n) => n.exists).map((n) => n.id.toLowerCase()));
  md = md.replace(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g, (_, target, alias) => {
    target = target.trim();
    const display = (alias || target).trim();
    const cls = names.has(target.toLowerCase()) ? "wikilink" : "wikilink unresolved";
    return `<span class="${cls}" data-note="${escapeHtml(target)}">${escapeHtml(display)}</span>`;
  });

  $("#note-body").innerHTML = fmHtml + marked.parse(md);
  $("#note-panel").classList.remove("hidden");

  // center graph on this node
  const node = graphData.nodes.find((n) => n.id.toLowerCase() === name.toLowerCase());
  if (node && node.x != null) graph.centerAt(node.x, node.y, 600);
}

$("#note-body").addEventListener("click", (e) => {
  const link = e.target.closest(".wikilink");
  if (link && !link.classList.contains("unresolved")) openNote(link.dataset.note);
});
$("#note-close").addEventListener("click", () => $("#note-panel").classList.add("hidden"));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadGraph();
addAssistantMsg(
  "Hi! I'm your vault librarian. Ask me anything about your knowledge base, " +
  "or **drop files anywhere on this page** and I'll file them, document them, and link them into the graph.\n\n" +
  "Try: *\"process the inbox\"*, *\"create a note on X\"*, or *\"what do I have about Y?\"*"
);
