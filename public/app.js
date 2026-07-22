/* Vault Librarian front-end
   Regions: rail | graph stage (+note panel) | chat dock
   Everything renders through esc()/sanitize before hitting innerHTML. */

"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ---------------------------------------------------------------------------
   Session identity + edit lock
   Each browser tab is its own librarian session (its own conversation). One
   tab at a time may hold the vault "edit lock"; everyone else is read-only
   until it is released (or the holder's tab closes).
--------------------------------------------------------------------------- */
const CLIENT_ID = (() => {
  let id = null;
  try { id = sessionStorage.getItem("vl-client"); } catch { }
  if (!id) {
    id = (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
      (Date.now().toString(36) + Math.random().toString(36).slice(2));
    try { sessionStorage.setItem("vl-client", id); } catch { }
  }
  return id;
})();

let editMode = false;          // does THIS tab currently hold the edit lock?
let editLockedByOther = false; // is another tab holding it right now?

// fetch wrapper that tags every request with this tab's client id
function api(url, opts = {}) {
  const headers = Object.assign({ "x-client-id": CLIENT_ID }, opts.headers || {});
  return fetch(url, Object.assign({}, opts, { headers }));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Strip active content out of rendered markdown before it enters the DOM. */
function sanitize(root) {
  root.querySelectorAll("script, style, iframe, object, embed, link, meta").forEach((n) => n.remove());
  root.querySelectorAll("*").forEach((n) => {
    for (const attr of [...n.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) n.removeAttribute(attr.name);
      if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value)) {
        n.removeAttribute(attr.name);
      }
    }
  });
  return root;
}

function setHtml(el, html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  sanitize(tpl.content);
  el.replaceChildren(tpl.content);
  return el;
}

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* ---------------------------------------------------------------------------
   Toasts (replace alert())
--------------------------------------------------------------------------- */
function toast(message, kind = "info", ms = 3800) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toasts").appendChild(el);
  const kill = () => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), reduceMotion.matches ? 0 : 200);
  };
  el.addEventListener("click", kill);
  setTimeout(kill, ms);
}

/* ---------------------------------------------------------------------------
   Theme
--------------------------------------------------------------------------- */
function currentTheme() { return document.documentElement.dataset.theme || "dark"; }

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("vl-theme", theme); } catch { /* private mode */ }
  refreshGraphTheme();
}

$("#rail-theme").addEventListener("click", () => {
  setTheme(currentTheme() === "dark" ? "light" : "dark");
});

/* ---------------------------------------------------------------------------
   Layout: focus modes + dock resize
--------------------------------------------------------------------------- */
const appEl = $("#app");
const FOCUS_MODES = ["split", "graph", "chat"];

function setFocusMode(mode) {
  appEl.dataset.focus = mode;
  try { localStorage.setItem("vl-focus", mode); } catch { }
  // canvas needs a resize after layout changes
  requestAnimationFrame(resizeGraph);
}
setFocusMode((() => {
  try { return FOCUS_MODES.includes(localStorage.getItem("vl-focus")) ? localStorage.getItem("vl-focus") : "split"; }
  catch { return "split"; }
})());

function cycleFocusMode() {
  const next = FOCUS_MODES[(FOCUS_MODES.indexOf(appEl.dataset.focus) + 1) % FOCUS_MODES.length];
  setFocusMode(next);
  toast(`Layout: ${next === "split" ? "graph + chat" : next === "graph" ? "graph only" : "chat only"}`, "info", 1600);
}
$("#rail-focus").addEventListener("click", cycleFocusMode);

/* Dock resize */
(() => {
  const handle = $("#dock-handle");
  let saved = null;
  try { saved = parseInt(localStorage.getItem("vl-dock-w"), 10); } catch { }
  if (saved && saved >= 300 && saved <= 800) {
    document.documentElement.style.setProperty("--dock-w", saved + "px");
  }
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    handle.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const w = Math.min(800, Math.max(300, window.innerWidth - e.clientX));
    document.documentElement.style.setProperty("--dock-w", w + "px");
    resizeGraph();
  });
  handle.addEventListener("pointerup", () => {
    dragging = false;
    handle.classList.remove("dragging");
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--dock-w"), 10);
    try { localStorage.setItem("vl-dock-w", String(w)); } catch { }
  });
})();

/* ---------------------------------------------------------------------------
   Markdown rendering (fence-safe while streaming, wikilinks as chips)
--------------------------------------------------------------------------- */
function knownNoteNames() {
  return new Set(graphData.nodes.filter((n) => n.exists).map((n) => n.id.toLowerCase()));
}

function mdToHtml(md, { streaming = false } = {}) {
  let text = String(md);
  if (streaming) {
    // an unclosed fence must not swallow the rest of the layout
    const fences = (text.match(/```/g) || []).length;
    if (fences % 2 === 1) text += "\n```";
  }
  const names = knownNoteNames();
  text = text.replace(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g, (_, target, alias) => {
    target = target.trim();
    const display = (alias || target).trim();
    const cls = names.has(target.toLowerCase()) ? "wikilink" : "wikilink unresolved";
    return `<span class="${cls}" data-note="${esc(target)}">${esc(display)}</span>`;
  });
  return marked.parse(text);
}

/* Upgrade code blocks: language label + copy button; add a copy-message action. */
function enhanceAssistant(el, rawMarkdown) {
  el.querySelectorAll("pre").forEach((pre) => {
    if (pre.closest(".code-block")) return;
    const code = pre.querySelector("code");
    const lang = (code?.className.match(/language-([\w-]+)/) || [])[1] || "text";
    const wrap = document.createElement("div");
    wrap.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-head";
    setHtml(head, `<span class="code-lang">${esc(lang)}</span><button class="copy-btn" type="button">Copy</button>`);
    head.querySelector(".copy-btn").addEventListener("click", (e) => {
      copyText(code ? code.textContent : pre.textContent, e.currentTarget);
    });
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(head);
    wrap.appendChild(pre);
  });
  if (rawMarkdown != null && !el.querySelector(".msg-actions")) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    setHtml(actions, `<button class="copy-btn" type="button" title="Copy message">Copy</button>`);
    actions.querySelector("button").addEventListener("click", (e) => copyText(rawMarkdown, e.currentTarget));
    el.appendChild(actions);
  }
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = "Copied";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = old; btn.classList.remove("copied"); }, 1400);
  }).catch(() => toast("Couldn't access the clipboard", "error"));
}

/* Clicking a wikilink chip anywhere opens the note. */
document.addEventListener("click", (e) => {
  const link = e.target.closest(".wikilink");
  if (link && !link.classList.contains("unresolved")) openNote(link.dataset.note);
  const chip = e.target.closest(".note-chip");
  if (chip && chip.dataset.note) openNote(chip.dataset.note);
});

/* ---------------------------------------------------------------------------
   Chat: transcript, streaming, tool groups
--------------------------------------------------------------------------- */
const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#send-btn");
const jumpBtn = $("#jump-latest");
let sending = false;
let stickToBottom = true;

/* transcript persistence (user/assistant text only) */
let transcript = [];
try { transcript = JSON.parse(localStorage.getItem("vl-transcript") || "[]"); } catch { }
function saveTranscript() {
  transcript = transcript.slice(-60);
  try { localStorage.setItem("vl-transcript", JSON.stringify(transcript)); } catch { }
}

messagesEl.addEventListener("scroll", () => {
  const gap = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  const wasStuck = stickToBottom;
  stickToBottom = gap < 100;
  if (stickToBottom) jumpBtn.hidden = true;
  else if (wasStuck && sending) jumpBtn.hidden = false;
});
jumpBtn.addEventListener("click", () => {
  stickToBottom = true;
  jumpBtn.hidden = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
});
function maybeScroll() {
  if (stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  else if (sending) jumpBtn.hidden = false;
}

function addUserMsg(text, { save = true } = {}) {
  const div = document.createElement("div");
  div.className = "msg-user";
  div.textContent = text;
  messagesEl.appendChild(div);
  if (save) { transcript.push({ r: "u", t: text }); saveTranscript(); }
  maybeScroll();
}

function addAssistantMsg(markdown, { save = true } = {}) {
  const div = document.createElement("div");
  div.className = "msg-assistant";
  setHtml(div, mdToHtml(markdown));
  enhanceAssistant(div, markdown);
  messagesEl.appendChild(div);
  if (save) { transcript.push({ r: "a", t: markdown }); saveTranscript(); }
  maybeScroll();
  return div;
}

function addStatus(text, isError = false) {
  const div = document.createElement("div");
  div.className = "status-line" + (isError ? " error" : "");
  div.textContent = text;
  messagesEl.appendChild(div);
  maybeScroll();
}

function setChatState(state) {
  // state: idle | busy
  $("#chat-status").textContent = state === "busy" ? "working" : "idle";
  $("#chat-status").dataset.state = state;
  $("#session-dot").dataset.state = state === "busy" ? "busy" : "live";
  $("#session-dot").title = state === "busy" ? "Librarian working" : "Session live";
  sendBtn.classList.toggle("stop", state === "busy");
  sendBtn.title = state === "busy" ? "Stop the librarian" : "Send (Enter)";
}

/* ---- edit lock (one editor at a time across all sessions) ---- */
const editCheck = $("#edit-check");
const editToggle = $("#edit-toggle");

function reflectEditState() {
  editCheck.checked = editMode;
  // only disable the box when someone ELSE holds the lock
  editCheck.disabled = editLockedByOther && !editMode;
  editToggle.classList.toggle("locked", editLockedByOther && !editMode);
  editToggle.classList.toggle("active", editMode);
  editToggle.title = editMode
    ? "Edit mode ON — the librarian and manual tools can change the vault. Uncheck to release it for others."
    : editLockedByOther
      ? "Another session is editing. You have read-only access until they release it."
      : "Read-only. Check to let the librarian and manual tools change the vault (one session at a time).";
  appEl.dataset.edit = editMode ? "on" : "off";
  document.body.classList.toggle("readonly", !editMode);
}

async function setEditMode(want) {
  try {
    const resp = await api("/api/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ want }),
    });
    const st = await resp.json();
    editMode = !!st.editing;
    editLockedByOther = !!st.lockedByOther;
    if (want && !editMode) toast("Another session is editing — you're read-only until they release it.", "info", 3400);
    else if (editMode) toast("Edit mode on — you can change the vault.", "success", 2200);
    else toast("Edit mode off — read-only.", "info", 1800);
  } catch {
    toast("Couldn't reach the server to change edit mode.", "error");
  }
  reflectEditState();
}

editCheck.addEventListener("change", () => setEditMode(editCheck.checked));

// Manual vault-editing actions check this first; read-only sessions get a hint.
function requireEditUI() {
  if (editMode) return true;
  toast("Turn on Edit mode (top of the chat panel) to change the vault.", "info", 3000);
  return false;
}

/* Heartbeat: keep this session alive and learn when the lock frees up. */
async function heartbeat() {
  try {
    const resp = await api("/api/heartbeat", { method: "POST" });
    if (!resp.ok) return;
    const st = await resp.json();
    editMode = !!st.editing;
    editLockedByOther = !!st.lockedByOther;
    reflectEditState();
  } catch { /* transient */ }
}
setInterval(heartbeat, 8000);
heartbeat();

/* Release the lock promptly when the tab closes or navigates away. */
window.addEventListener("pagehide", () => {
  try { navigator.sendBeacon("/api/session/close?id=" + encodeURIComponent(CLIENT_ID)); } catch { }
});

reflectEditState();

/* ---- tool activity block ---- */
function newToolGroup() {
  const el = document.createElement("div");
  el.className = "tool-group";
  el.dataset.open = "true";
  el.setAttribute("aria-busy", "true");
  setHtml(el, `
    <button class="tool-summary" type="button" aria-expanded="true">
      <svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
      <span class="t-label">Working in the vault…</span>
      <span class="t-count"></span>
    </button>
    <div class="tool-steps"></div>`);
  el.querySelector(".tool-summary").addEventListener("click", () => {
    const open = el.dataset.open === "true";
    el.dataset.open = open ? "false" : "true";
    el.querySelector(".tool-summary").setAttribute("aria-expanded", String(!open));
  });
  messagesEl.appendChild(el);
  maybeScroll();
  return { el, count: 0, started: performance.now(), notes: new Set() };
}

const TOOL_VERBS = {
  Read: "Reading", Write: "Writing", Edit: "Editing", Glob: "Scanning files",
  Grep: "Searching vault", Bash: "Running", WebSearch: "Searching the web",
  WebFetch: "Fetching", Task: "Delegating", TodoWrite: "Planning",
};

function describeTool(name, input) {
  const verb = TOOL_VERBS[name] || name;
  const noteName = noteFromPath(input);
  if (noteName) {
    return { html: `${esc(verb)} <span class="note-chip" data-note="${esc(noteName)}">${esc(noteName)}</span>`, note: noteName };
  }
  return { html: input ? `${esc(verb)} <span>${esc(input)}</span>` : esc(verb), note: null };
}

function noteFromPath(input) {
  if (!input) return null;
  const m = String(input).match(/([^\\/]+)\.md$/i);
  if (!m) return null;
  const name = m[1];
  const node = graphData.nodes.find((n) => n.exists && n.id.toLowerCase() === name.toLowerCase());
  return node ? node.id : null;
}

function addToolStep(group, name, input) {
  // previous step is no longer the active one
  group.el.querySelectorAll(".tool-step.running").forEach((s) => s.classList.remove("running"));
  const { html, note } = describeTool(name, input);
  if (note) group.notes.add(note);

  const step = document.createElement("div");
  step.className = "tool-step running";
  step.setAttribute("role", "button");
  step.tabIndex = 0;
  setHtml(step, `
    <span class="step-dot"></span>
    <span class="step-name">${esc(name)}</span>
    <span class="step-desc">${html}</span>`);
  const detail = document.createElement("div");
  detail.className = "step-detail";
  detail.textContent = input || "(no input)";
  const toggleDetail = () => { step.dataset.open = step.dataset.open === "true" ? "false" : "true"; };
  step.addEventListener("click", (e) => { if (!e.target.closest(".note-chip")) toggleDetail(); });
  step.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleDetail(); } });

  const steps = group.el.querySelector(".tool-steps");
  steps.appendChild(step);
  steps.appendChild(detail);
  group.count++;
  group.el.querySelector(".t-count").textContent = String(group.count);
  maybeScroll();
}

function finalizeToolGroup(group) {
  if (!group) return;
  group.el.querySelectorAll(".tool-step.running").forEach((s) => s.classList.remove("running"));
  group.el.removeAttribute("aria-busy");
  group.el.dataset.open = "false";
  group.el.querySelector(".tool-summary").setAttribute("aria-expanded", "false");
  const secs = ((performance.now() - group.started) / 1000).toFixed(1);
  const notes = group.notes.size ? ` · ${group.notes.size} note${group.notes.size > 1 ? "s" : ""}` : "";
  group.el.querySelector(".t-label").textContent =
    `Used ${group.count} tool${group.count > 1 ? "s" : ""}${notes} · ${secs}s`;
}

/* ---- send / stream ---- */
async function sendMessage(text, displayText) {
  text = String(text || "").trim();
  if (sending || !text) return;
  sending = true;
  setChatState("busy");
  stickToBottom = true;
  addUserMsg(displayText != null ? displayText : text, { save: displayText == null });
  if (displayText != null) { transcript.push({ r: "u", t: displayText }); saveTranscript(); }

  const thinking = document.createElement("div");
  thinking.className = "thinking";
  thinking.textContent = "Thinking…";
  messagesEl.appendChild(thinking);
  maybeScroll();

  let streamEl = null;   // assistant message currently receiving deltas
  let streamRaw = "";
  let renderQueued = false;
  let toolGroup = null;
  let vaultChanged = false;
  let sawContent = false;

  const clearThinking = () => { if (thinking.isConnected) thinking.remove(); };

  const renderStream = () => {
    if (renderQueued || !streamEl) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!streamEl) return;
      setHtml(streamEl, mdToHtml(streamRaw, { streaming: true }));
      streamEl.classList.add("caret");
      maybeScroll();
    });
  };

  const openStream = () => {
    if (streamEl) return;
    streamEl = document.createElement("div");
    streamEl.className = "msg-assistant caret";
    messagesEl.appendChild(streamEl);
    maybeScroll();
  };

  const closeStream = (finalText) => {
    if (!streamEl) return;
    const raw = finalText != null ? finalText : streamRaw;
    streamEl.classList.remove("caret");
    setHtml(streamEl, mdToHtml(raw));
    enhanceAssistant(streamEl, raw);
    transcript.push({ r: "a", t: raw });
    saveTranscript();
    streamEl = null;
    streamRaw = "";
    maybeScroll();
  };

  const closeTools = () => { if (toolGroup) { finalizeToolGroup(toolGroup); toolGroup = null; } };

  try {
    const resp = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });

    if (!resp.ok) {
      let msg = `Error ${resp.status}`;
      try { msg = (await resp.json()).error || msg; } catch { }
      addStatus(msg, true);
      if (!inputEl.value) { inputEl.value = text; autogrow(); }
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

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

        if (evt.kind === "delta") {
          clearThinking(); closeTools();
          sawContent = true;
          openStream();
          streamRaw += evt.text;
          renderStream();
        } else if (evt.kind === "text") {
          clearThinking(); closeTools();
          sawContent = true;
          if (streamEl) closeStream(evt.text);
          else addAssistantMsg(evt.text);
        } else if (evt.kind === "tool") {
          clearThinking();
          if (streamEl) closeStream();
          if (!toolGroup) toolGroup = newToolGroup();
          addToolStep(toolGroup, evt.name, evt.input);
          if (["Write", "Edit", "Bash"].includes(evt.name)) vaultChanged = true;
        } else if (evt.kind === "result") {
          clearThinking(); closeTools();
          if (streamEl) closeStream();
          const cost = evt.costUsd != null ? ` · $${evt.costUsd.toFixed(4)}` : "";
          const secs = evt.durationMs != null ? ` · ${(evt.durationMs / 1000).toFixed(1)}s` : "";
          addStatus(evt.ok ? `done${secs}${cost}` : `stopped: ${evt.error}${secs}`, !evt.ok);
        } else if (evt.kind === "error") {
          clearThinking(); closeTools();
          if (streamEl) closeStream();
          addStatus(evt.message, true);
        }
      }
    }
    if (!sawContent && thinking.isConnected) addStatus("The librarian returned no reply.", true);
    if (vaultChanged) loadGraph({ keepView: true });
  } catch (err) {
    addStatus("Connection error: " + err.message, true);
    if (!inputEl.value) { inputEl.value = text; autogrow(); }
  } finally {
    clearThinking();
    closeTools();
    if (streamEl) closeStream();
    sending = false;
    setChatState("idle");
    jumpBtn.hidden = true;
  }
}

async function stopGeneration() {
  try {
    await api("/api/stop", { method: "POST" });
    toast("Stopping the librarian…", "info", 2000);
  } catch {
    toast("Couldn't reach the server to stop", "error");
  }
}

sendBtn.addEventListener("click", () => {
  if (sending) return stopGeneration();
  const text = inputEl.value;
  inputEl.value = "";
  autogrow();
  sendMessage(text);
});

$("#reset-btn").addEventListener("click", resetChat);
$("#rail-new-chat").addEventListener("click", resetChat);

async function resetChat() {
  try { await api("/api/reset", { method: "POST" }); } catch { }
  messagesEl.replaceChildren();
  transcript = [];
  saveTranscript();
  addWelcome();
  toast("New conversation started", "success", 2200);
}

/* ---- composer ---- */
function autogrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + "px";
}
inputEl.addEventListener("input", () => { autogrow(); updateSlashPop(); });

inputEl.addEventListener("keydown", (e) => {
  const pop = $("#slash-pop");
  if (!pop.hidden) {
    const items = [...pop.querySelectorAll(".slash-item")];
    let idx = items.findIndex((i) => i.dataset.active === "true");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      idx = e.key === "ArrowDown" ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
      items.forEach((i, n) => i.dataset.active = String(n === idx));
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      (items[idx >= 0 ? idx : 0])?.click();
      return;
    }
    if (e.key === "Escape") { pop.hidden = true; return; }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (sending) return;
    const text = inputEl.value;
    inputEl.value = "";
    autogrow();
    sendMessage(text);
  }
});

/* ---- slash commands ---- */
const SLASH_COMMANDS = [
  {
    cmd: "/process-inbox", desc: "File everything sitting in Inbox/",
    prompt: "Process the inbox: for each note in Inbox/, give it a proper title and frontmatter, link it per the vault rules, move it to the right folder, and update the affected hubs. Summarize what you did.",
  },
  {
    cmd: "/audit", desc: "Run a full graph audit",
    prompt: "Run a full graph audit: check every edge against the linking rules, verify every note is reachable from the company note, find unresolved links and missing frontmatter. Report violations before fixing anything.",
  },
  {
    cmd: "/recent", desc: "What changed lately?",
    prompt: "Summarize the most recent activity in the vault: check Meta/Activity Log.md and tell me what changed recently and anything that needs follow-up.",
  },
];

function updateSlashPop() {
  const pop = $("#slash-pop");
  const v = inputEl.value;
  if (!v.startsWith("/") || v.includes("\n") || v.length > 24) { pop.hidden = true; return; }
  const matches = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(v.toLowerCase()));
  if (!matches.length) { pop.hidden = true; return; }
  pop.replaceChildren(...matches.map((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "slash-item";
    b.dataset.active = String(i === 0);
    setHtml(b, `<span class="s-cmd">${esc(c.cmd)}</span><span class="s-desc">${esc(c.desc)}</span>`);
    b.addEventListener("click", () => {
      pop.hidden = true;
      inputEl.value = "";
      autogrow();
      sendMessage(c.prompt, c.cmd);
    });
    return b;
  }));
  pop.hidden = false;
}

/* ---------------------------------------------------------------------------
   Upload: drop overlay, staging dialog, chat system card
--------------------------------------------------------------------------- */
const overlay = $("#drop-overlay");
const dialog = $("#upload-dialog");
let pendingFiles = [];
let dragDepth = 0;

window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (e.dataTransfer?.types?.includes("Files")) {
    dragDepth++;
    overlay.hidden = false;
  }
});
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; overlay.classList.remove("armed"); }
});
window.addEventListener("dragover", (e) => { e.preventDefault(); overlay.classList.add("armed"); });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  overlay.classList.remove("armed");
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) stageUpload(files);
});

$("#attach-btn").addEventListener("click", () => $("#file-input").click());
$("#rail-upload").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (files.length) stageUpload(files);
});

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

function stageUpload(files) {
  if (!requireEditUI()) return;
  pendingFiles = files;
  const list = $("#upload-list");
  list.replaceChildren(...files.map((f) => {
    const li = document.createElement("li");
    setHtml(li, `<span class="f-name">${esc(f.name)}</span><span class="f-size">${esc(formatSize(f.size))}</span>`);
    return li;
  }));
  $("#upload-desc").value = "";
  dialog.showModal();
}

$("#upload-cancel").addEventListener("click", () => { pendingFiles = []; dialog.close(); });

$("#upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  dialog.close();
  const desc = $("#upload-desc").value.trim();
  const files = pendingFiles;
  pendingFiles = [];
  if (!files.length) return;

  // staged status card in the transcript
  const card = document.createElement("div");
  card.className = "sys-card";
  setHtml(card, `
    <div class="sys-title">
      <svg viewBox="0 0 24 24"><path d="M21 15v3a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-3"/><path d="M12 16V4m0 0L7 9m5-5l5 5"/></svg>
      <span>Ingesting ${files.length} file${files.length > 1 ? "s" : ""}</span>
    </div>
    <div class="file-rows"></div>`);
  const rows = new Map();
  const rowsEl = card.querySelector(".file-rows");
  for (const f of files) {
    const row = document.createElement("div");
    row.className = "file-card";
    setHtml(row, `<span class="f-name">${esc(f.name)}</span><span class="f-status">uploading…</span>`);
    rowsEl.appendChild(row);
    rows.set(f.name, row);
  }
  messagesEl.appendChild(card);
  stickToBottom = true;
  maybeScroll();

  const setRow = (name, statusHtml, cls) => {
    // match by basename since the server may rename on collision
    const row = rows.get(name) || [...rows.values()].find((r) => !r.dataset.done);
    if (!row) return;
    row.dataset.done = "1";
    const st = row.querySelector(".f-status");
    setHtml(st, statusHtml);
    st.className = "f-status " + (cls || "");
  };

  const form = new FormData();
  for (const f of files) form.append("files", f);

  try {
    const resp = await api("/api/upload", { method: "POST", body: form });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.status);

    for (const p of data.kept || []) {
      setRow(p.split("/").pop(), `<span class="f-dest">→ Inbox/Uploads</span>`, "ok");
    }
    for (const p of data.attachments || []) {
      setRow(p.split("/").pop(), `<span class="f-dest">→ Meta/Attachments</span>`, "ok");
    }
    for (const w of data.warnings || []) {
      addStatus(w, true);
    }
    card.querySelector(".sys-title span").textContent = "Files staged — handing to the librarian";

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

    const display = `Process ${files.length} uploaded file${files.length > 1 ? "s" : ""}` + (desc ? ` — ${desc}` : "");
    sendMessage(msg, display);
  } catch (err) {
    card.querySelector(".sys-title span").textContent = "Upload failed";
    for (const row of rows.values()) {
      if (!row.dataset.done) {
        const st = row.querySelector(".f-status");
        st.textContent = "failed";
        st.className = "f-status warn";
      }
    }
    addStatus("Upload failed: " + err.message, true);
    toast("Upload failed — files were not handed to the librarian", "error");
  }
});

/* ---------------------------------------------------------------------------
   Graph
--------------------------------------------------------------------------- */
/* Types in structural-rank order — the legend reads as one progression
   outward from the company root, and colors form a warm->cool gradient. */
const NODE_TYPES = [
  "company",                      // rank 0 — root
  "division",                     // rank 1
  "department", "work-center",    // rank 2
  "cell", "program", "moc", "area", // rank 3
  "person",                       // attaches at the org levels
  "project", "report-series", "report", // rank 4
  "vendor",                       // attaches beside projects/assets
  "machine", "hardware", "software", "server", "website", // rank 5 — assets
  "resource", "daily", "note", "template", // tail
  "unresolved",
];

/* BFS depth from the company root is only a FALLBACK for nodes whose type has
   no anchor color: depth d borrows the ramp color of the type at that rank. */
const ROOT_NOTE = "Bobrick Washroom Equipment, Inc.";
const DEPTH_FALLBACK = ["company", "division", "department", "cell", "project", "machine", "resource", "note"];

let graph = null;
let graphData = { nodes: [], links: [] };
let nodeById = new Map();     // id -> node object
let degree = new Map();       // id -> link count
let neighbors = new Map();    // id -> Set(ids)
let topDegreeIds = new Set(); // always-labelled hubs
let depths = new Map();       // id -> hops from the company root (fallback coloring)
let hoverNode = null;
let selectedId = null;
let hiddenTypes = new Set();
let showOrphans = true;
let focusState = null;        // { rootId, depth, visible:Set }
let graphTheme = {};

try { hiddenTypes = new Set(JSON.parse(localStorage.getItem("vl-hidden-types") || "[]")); } catch { }
try { showOrphans = localStorage.getItem("vl-orphans") !== "0"; } catch { }

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function readGraphTheme() {
  const t = {
    bg: cssVar("--graph-bg"),
    link: cssVar("--graph-link"),
    label: cssVar("--graph-label"),
    labelDim: cssVar("--graph-label-dim"),
    ring: cssVar("--graph-ring"),
    types: {},
  };
  for (const type of NODE_TYPES) t.types[type] = cssVar("--node-" + type) || cssVar("--node-note");
  return t;
}

function typeColor(type) {
  return graphTheme.types?.[type] || graphTheme.types?.note || "#94A3B8";
}

/* Fill color for a node: its type's ramp anchor; unknown types fall back to
   their BFS depth's rank color; unreachable/unresolved stay muted gray. */
function nodeFill(node) {
  if (!node.exists) return typeColor("unresolved");
  if (graphTheme.types?.[node.type]) return graphTheme.types[node.type];
  const d = depths.get(node.id);
  if (d == null) return typeColor("unresolved");
  return typeColor(DEPTH_FALLBACK[Math.min(d, DEPTH_FALLBACK.length - 1)]);
}

function computeDepths() {
  depths = new Map();
  const root = graphData.nodes.find((n) => n.id.toLowerCase() === ROOT_NOTE.toLowerCase());
  if (!root) return;
  depths.set(root.id, 0);
  let frontier = [root.id];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      const d = depths.get(id);
      for (const nb of neighbors.get(id) || []) {
        if (!depths.has(nb)) { depths.set(nb, d + 1); next.push(nb); }
      }
    }
    frontier = next;
  }
}

function refreshGraphTheme() {
  graphTheme = readGraphTheme();
  if (graph) {
    graph.backgroundColor(graphTheme.bg);
    graph.linkColor(() => graphTheme.link);
    renderLegend();
  }
}

function nodeVisible(n) {
  if (hiddenTypes.has(n.type)) return false;
  if (!showOrphans && (degree.get(n.id) || 0) === 0) return false;
  if (focusState && !focusState.visible.has(n.id)) return false;
  return true;
}

function nodeRadius(n) {
  const d = degree.get(n.id) || 0;
  const r = 3.5 + Math.sqrt(d) * 1.35;
  const base = Math.max(4, Math.min(14, r));
  return n.exists ? base : Math.max(3, base * 0.7);
}

async function loadGraph({ keepView = false } = {}) {
  $("#graph-error").hidden = true;
  try {
    const resp = await fetch("/api/graph");
    if (!resp.ok) throw new Error(`server returned ${resp.status}`);
    const data = await resp.json();
    if (!data || !Array.isArray(data.nodes)) throw new Error("malformed graph payload");
    graphData = data;
  } catch (err) {
    $("#graph-error-msg").textContent = `The graph failed to load — ${err.message}.`;
    $("#graph-error").hidden = false;
    return;
  }

  // keep node positions stable across reloads
  if (graph) {
    const prev = new Map(graph.graphData().nodes.map((n) => [n.id, n]));
    for (const n of graphData.nodes) {
      const p = prev.get(n.id);
      if (p) { n.x = p.x; n.y = p.y; n.vx = p.vx; n.vy = p.vy; }
    }
  }

  degree = new Map();
  neighbors = new Map();
  nodeById = new Map();
  for (const n of graphData.nodes) { degree.set(n.id, 0); neighbors.set(n.id, new Set()); nodeById.set(n.id, n); }
  for (const l of graphData.links) {
    const s = typeof l.source === "object" ? l.source.id : l.source;
    const t = typeof l.target === "object" ? l.target.id : l.target;
    degree.set(s, (degree.get(s) || 0) + 1);
    degree.set(t, (degree.get(t) || 0) + 1);
    neighbors.get(s)?.add(t);
    neighbors.get(t)?.add(s);
  }
  const byDegree = [...degree.entries()].sort((a, b) => b[1] - a[1]);
  topDegreeIds = new Set(byDegree.slice(0, 8).filter(([, d]) => d >= 3).map(([id]) => id));
  computeDepths();

  if (focusState && !degree.has(focusState.rootId)) exitFocusMode();
  if (focusState) computeFocusVisible();

  if (!graph) initGraph();
  graph.graphData(graphData);
  if (!keepView && graphData.nodes.length && !reduceMotion.matches) {
    setTimeout(() => graph.zoomToFit(500, 60), 600);
  }
  renderLegend();
  refreshDatalist();
  updateEmptyState();
}

/* re-set the visibility accessors so force-graph re-evaluates them */
function refreshVisibility() {
  if (!graph) return;
  graph.nodeVisibility((n) => nodeVisible(n));
  graph.linkVisibility((l) => linkVisible(l));
  updateEmptyState();
}

function linkVisible(l) {
  const s = typeof l.source === "object" ? l.source : nodeById.get(l.source);
  const t = typeof l.target === "object" ? l.target : nodeById.get(l.target);
  return !!(s && t && nodeVisible(s) && nodeVisible(t));
}

function initGraph() {
  graphTheme = readGraphTheme();
  const el = $("#graph");
  graph = ForceGraph()(el)
    .backgroundColor(graphTheme.bg)
    .nodeId("id")
    .nodeVal((n) => nodeRadius(n))
    .nodeLabel((n) => {
      const d = degree.get(n.id) || 0;
      return `<div class="tooltip-title">${esc(n.id)}</div>
        <div class="tooltip-meta">${esc(n.exists ? n.type : "unresolved")} · ${d} link${d === 1 ? "" : "s"}</div>`;
    })
    .nodeVisibility((n) => nodeVisible(n))
    .linkVisibility((l) => linkVisible(l))
    .nodePointerAreaPaint((node, color, ctx) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, nodeRadius(node) + 2, 0, 2 * Math.PI);
      ctx.fill();
    })
    .nodeCanvasObject((node, ctx, globalScale) => {
      const r = nodeRadius(node);
      const highlightActive = hoverNode || selectedId;
      const focusId = hoverNode ? hoverNode.id : selectedId;
      const inNeighborhood = !highlightActive ||
        node.id === focusId || neighbors.get(focusId)?.has(node.id);

      let alpha = node.exists ? 1 : 0.5;
      if (highlightActive && !inNeighborhood) alpha = 0.16;

      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = nodeFill(node);
      ctx.fill();

      if (node.id === selectedId) {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 2.5, 0, 2 * Math.PI);
        ctx.strokeStyle = graphTheme.ring;
        ctx.lineWidth = 1.6 / globalScale;
        ctx.stroke();
      }

      // zoom-adaptive labels: fade in as screen radius crosses ~8px;
      // hubs + selection + hover neighborhood always labelled.
      const screenR = r * globalScale;
      let labelAlpha = Math.max(0, Math.min(1, (screenR - 8) / 5));
      const forced = node.id === selectedId ||
        (hoverNode && (node.id === hoverNode.id || neighbors.get(hoverNode.id)?.has(node.id))) ||
        topDegreeIds.has(node.id);
      if (forced) labelAlpha = Math.max(labelAlpha, 0.95);
      if (highlightActive && !inNeighborhood) labelAlpha = 0;

      if (labelAlpha > 0.02) {
        const fontSize = Math.max(11 / globalScale, 2.2);
        ctx.font = `500 ${fontSize}px Inter, "Segoe UI", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.globalAlpha = labelAlpha * (node.exists ? 1 : 0.65);
        ctx.fillStyle = node.exists ? graphTheme.label : graphTheme.labelDim;
        ctx.fillText(node.id, node.x, node.y + r + 2 / globalScale);
      }
      ctx.globalAlpha = 1;
    })
    .linkColor(() => graphTheme.link)
    .linkWidth(1)
    .onNodeHover((node) => {
      hoverNode = node || null;
      el.style.cursor = node ? "pointer" : "";
    })
    .onNodeClick((node) => {
      selectedId = node.id;
      if (node.exists) openNote(node.id);
    })
    .onNodeRightClick((node) => enterFocusMode(node.id))
    .onBackgroundClick(() => { selectedId = null; })
    .width(el.clientWidth)
    .height(el.clientHeight);

  window.addEventListener("resize", resizeGraph);
}

function resizeGraph() {
  const el = $("#graph");
  if (graph && el.clientWidth) graph.width(el.clientWidth).height(el.clientHeight);
}

function centerOn(id, zoomLevel = 3) {
  if (!graph) return;
  const node = graphData.nodes.find((n) => n.id.toLowerCase() === id.toLowerCase());
  if (!node || node.x == null) return;
  selectedId = node.id;
  const ms = reduceMotion.matches ? 0 : 600;
  graph.centerAt(node.x, node.y, ms);
  if (graph.zoom() < zoomLevel) graph.zoom(zoomLevel, ms);
}

/* legend doubles as a type filter */
function renderLegend() {
  const rank = (t) => { const i = NODE_TYPES.indexOf(t); return i === -1 ? NODE_TYPES.length : i; };
  const present = [...new Set(graphData.nodes.map((n) => n.type))]
    .sort((a, b) => rank(a) - rank(b));
  const legend = $("#legend");
  legend.replaceChildren(...present.map((type) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "legend-item";
    b.setAttribute("aria-pressed", String(!hiddenTypes.has(type)));
    b.title = `Click to ${hiddenTypes.has(type) ? "show" : "hide"} ${type} notes`;
    setHtml(b, `<span class="legend-dot" style="background:${esc(typeColor(type))}"></span>${esc(type)}`);
    b.addEventListener("click", () => {
      if (hiddenTypes.has(type)) hiddenTypes.delete(type); else hiddenTypes.add(type);
      try { localStorage.setItem("vl-hidden-types", JSON.stringify([...hiddenTypes])); } catch { }
      renderLegend();
      refreshVisibility();
    });
    return b;
  }));
}

function updateEmptyState() {
  const anyVisible = graphData.nodes.some(nodeVisible);
  $("#graph-empty").hidden = anyVisible || !graphData.nodes.length;
}

$("#clear-filters").addEventListener("click", () => {
  hiddenTypes.clear();
  showOrphans = true;
  exitFocusMode();
  try {
    localStorage.setItem("vl-hidden-types", "[]");
    localStorage.setItem("vl-orphans", "1");
  } catch { }
  $("#orphans-toggle").setAttribute("aria-pressed", "true");
  renderLegend();
  refreshVisibility();
});

$("#orphans-toggle").addEventListener("click", (e) => {
  showOrphans = !showOrphans;
  e.currentTarget.setAttribute("aria-pressed", String(showOrphans));
  try { localStorage.setItem("vl-orphans", showOrphans ? "1" : "0"); } catch { }
  refreshVisibility();
});

$("#refresh-graph").addEventListener("click", () => loadGraph());
$("#graph-retry").addEventListener("click", () => loadGraph());

/* neighborhood focus mode (right-click a node, or via palette) */
function computeFocusVisible() {
  const { rootId, depth } = focusState;
  const visible = new Set([rootId]);
  let frontier = [rootId];
  for (let hop = 0; hop < depth; hop++) {
    const next = [];
    for (const id of frontier) {
      for (const nb of neighbors.get(id) || []) {
        if (!visible.has(nb)) { visible.add(nb); next.push(nb); }
      }
    }
    frontier = next;
  }
  focusState.visible = visible;
}

function enterFocusMode(rootId) {
  focusState = { rootId, depth: parseInt($("#focus-depth").value, 10) || 1, visible: new Set() };
  computeFocusVisible();
  $("#focus-controls").hidden = false;
  selectedId = rootId;
  refreshVisibility();
  centerOn(rootId, 2.5);
  toast(`Focused on "${rootId}" — right-click nodes to refocus`, "info", 2600);
}

function exitFocusMode() {
  focusState = null;
  $("#focus-controls").hidden = true;
  refreshVisibility();
}

$("#focus-depth").addEventListener("change", () => {
  if (!focusState) return;
  focusState.depth = parseInt($("#focus-depth").value, 10) || 1;
  computeFocusVisible();
  refreshVisibility();
});
$("#focus-exit").addEventListener("click", exitFocusMode);

function refreshDatalist() {
  $("#node-list").replaceChildren(...graphData.nodes
    .filter((n) => n.exists)
    .map((n) => Object.assign(document.createElement("option"), { value: n.id })));
}

/* ---------------------------------------------------------------------------
   Note viewer
--------------------------------------------------------------------------- */
let currentNote = null; // { name, markdown }

async function openNote(name) {
  let data;
  try {
    const resp = await fetch(`/api/note?name=${encodeURIComponent(name)}`);
    if (!resp.ok) throw new Error(resp.status === 404 ? "note not found" : `server returned ${resp.status}`);
    data = await resp.json();
  } catch (err) {
    toast(`Couldn't open "${name}" — ${err.message}`, "error");
    return;
  }
  currentNote = { name: data.name, markdown: data.markdown };
  showViewer();
  renderConnections(data.name, data.markdown);
  renderBacklinks(data.name);

  $("#note-title").textContent = data.name;
  $("#note-path").textContent = data.path;

  let md = data.markdown;
  const fmMatch = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const badges = [];
  if (fmMatch) {
    md = md.slice(fmMatch[0].length);
    const fm = {};
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
    if (fm.type) badges.push(`<span class="badge"><span class="legend-dot" style="background:${esc(typeColor(fm.type))}"></span>${esc(fm.type)}</span>`);
    if (fm.status) badges.push(`<span class="badge"><b>status</b> ${esc(fm.status)}</span>`);
    if (fm.created) badges.push(`<span class="badge mono-badge">${esc(fm.created)}</span>`);
    const tags = (fm.tags || "").replace(/[\[\]]/g, "").split(",").map((t) => t.trim()).filter(Boolean);
    for (const t of tags) badges.push(`<span class="badge"><b>#</b>${esc(t)}</span>`);
  }
  setHtml($("#note-badges"), badges.join(""));

  setHtml($("#note-body"), mdToHtml(md));
  enhanceAssistant($("#note-body"), null);
  $("#note-panel").hidden = false;

  if (appEl.dataset.focus === "chat") setFocusMode("split");
  centerOn(data.name);
}

function closeNotePanel() {
  $("#note-panel").hidden = true;
  currentNote = null;
}
$("#note-close").addEventListener("click", closeNotePanel);

$("#note-ask").addEventListener("click", () => {
  if (!currentNote) return;
  if (appEl.dataset.focus === "graph") setFocusMode("split");
  const mention = `Regarding [[${currentNote.name}]]: `;
  inputEl.value = inputEl.value ? inputEl.value + "\n" + mention : mention;
  autogrow();
  inputEl.focus();
  inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
});

/* editing */
function showViewer() {
  $("#note-body").hidden = false;
  $("#note-editor").hidden = true;
}
$("#note-focus").addEventListener("click", () => {
  if (!currentNote) return;
  if (appEl.dataset.focus === "chat") setFocusMode("split");
  closeNotePanel();
  enterFocusMode(currentNote.name);
});

$("#note-edit").addEventListener("click", () => {
  if (!currentNote) return;
  if (!requireEditUI()) return;
  $("#note-source").value = currentNote.markdown;
  $("#note-body").hidden = true;
  $("#note-editor").hidden = false;
  $("#note-source").focus();
});
$("#edit-cancel-note").addEventListener("click", showViewer);
$("#edit-save-note").addEventListener("click", async () => {
  if (!currentNote) return;
  try {
    const resp = await api("/api/note", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: currentNote.name, markdown: $("#note-source").value }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `server returned ${resp.status}`);
    }
    toast("Note saved", "success", 2200);
    await loadGraph({ keepView: true });
    openNote(currentNote.name);
  } catch (err) {
    toast("Save failed: " + err.message, "error");
  }
});

/* connections + backlinks */
function renderConnections(name, markdown) {
  const stripped = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const reasons = new Map();
  for (const m of stripped.matchAll(/^\s*- \[\[([^\]|#\n]+)(?:\|[^\]]*)?\]\]\s*(?:—|-)?\s*(.*)$/gm)) {
    reasons.set(m[1].trim(), m[2].trim());
  }
  const linked = new Set();
  for (const m of stripped.matchAll(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) {
    const t = m[1].trim();
    if (t && t !== name && !t.includes(".")) linked.add(t);
  }
  const list = $("#conn-list");
  list.replaceChildren(...[...linked].sort().map((target) => {
    const li = document.createElement("li");
    setHtml(li,
      `<span class="conn-name">${esc(target)}</span>` +
      `<span class="conn-why">${esc(reasons.get(target) || "(documented in note body)")}</span>` +
      `<button class="conn-del" type="button" title="Disconnect both notes">unlink</button>`);
    li.querySelector(".conn-name").addEventListener("click", () => openNote(target));
    li.querySelector(".conn-del").addEventListener("click", () => confirmUnlink(li, name, target));
    return li;
  }));
}

function confirmUnlink(li, name, target) {
  if (!requireEditUI()) return;
  if (li.querySelector(".conn-confirm")) return;
  const del = li.querySelector(".conn-del");
  del.hidden = true;
  const box = document.createElement("span");
  box.className = "conn-confirm";
  setHtml(box, `<span>unlink both?</span><button type="button" class="yes">Yes</button><button type="button" class="no">No</button>`);
  box.querySelector(".no").addEventListener("click", () => { box.remove(); del.hidden = false; });
  box.querySelector(".yes").addEventListener("click", async () => {
    try {
      const resp = await api("/api/link", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: name, to: target }),
      });
      if (!resp.ok) throw new Error(`server returned ${resp.status}`);
      toast(`Disconnected "${name}" and "${target}"`, "success");
      await loadGraph({ keepView: true });
      openNote(name);
    } catch (err) {
      toast("Disconnect failed: " + err.message, "error");
      box.remove();
      del.hidden = false;
    }
  });
  li.appendChild(box);
}

function renderBacklinks(name) {
  const sources = new Set();
  for (const l of graphData.links) {
    const s = typeof l.source === "object" ? l.source.id : l.source;
    const t = typeof l.target === "object" ? l.target.id : l.target;
    if (t.toLowerCase() === name.toLowerCase() && s.toLowerCase() !== name.toLowerCase()) sources.add(s);
  }
  const list = $("#backlink-list");
  $("#backlinks-title").hidden = sources.size === 0;
  list.replaceChildren(...[...sources].sort().map((src) => {
    const li = document.createElement("li");
    setHtml(li, `<span class="conn-name">${esc(src)}</span>`);
    li.querySelector(".conn-name").addEventListener("click", () => openNote(src));
    return li;
  }));
}

$("#conn-add-btn").addEventListener("click", async () => {
  if (!currentNote) return;
  if (!requireEditUI()) return;
  const to = $("#conn-target").value.trim();
  const reason = $("#conn-reason").value.trim();
  if (!to) return;
  if (!reason) { toast("Per the vault rules, every connection needs a documented reason.", "error"); return; }
  try {
    const resp = await api("/api/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: currentNote.name, to, reason }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `server returned ${resp.status}`);
    }
    $("#conn-target").value = "";
    $("#conn-reason").value = "";
    toast(`Connected "${currentNote.name}" and "${to}"`, "success");
    await loadGraph({ keepView: true });
    openNote(currentNote.name);
  } catch (err) {
    toast("Link failed: " + err.message, "error");
  }
});

/* ---------------------------------------------------------------------------
   Command palette (Ctrl+K)
--------------------------------------------------------------------------- */
const paletteOverlay = $("#palette-overlay");
const paletteInput = $("#palette-input");
const paletteList = $("#palette-list");
let paletteItems = [];
let paletteIndex = 0;

const PALETTE_ACTIONS = [
  { label: "New chat", run: resetChat },
  { label: "Switch theme", run: () => setTheme(currentTheme() === "dark" ? "light" : "dark") },
  { label: "Cycle layout", run: cycleFocusMode },
  { label: "Reload graph", run: () => loadGraph() },
  { label: "Toggle orphan notes", run: () => $("#orphans-toggle").click() },
  { label: "Focus on selected node", run: () => { if (selectedId) enterFocusMode(selectedId); else toast("Select a node first", "info"); } },
  { label: "Exit neighborhood focus", run: exitFocusMode },
  { label: "Process the inbox", run: () => sendMessage(SLASH_COMMANDS[0].prompt, "/process-inbox") },
  { label: "Run a graph audit", run: () => sendMessage(SLASH_COMMANDS[1].prompt, "/audit") },
];

function fuzzyScore(query, target) {
  // subsequence match; contiguous + prefix matches score higher
  query = query.toLowerCase();
  target = target.toLowerCase();
  if (!query) return 1;
  const idx = target.indexOf(query);
  if (idx === 0) return 1000 - target.length;
  if (idx > 0) return 500 - idx - target.length * 0.1;
  let qi = 0, score = 0, streak = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) { qi++; streak++; score += streak * 2; }
    else streak = 0;
  }
  return qi === query.length ? score - target.length * 0.1 : -1;
}

function openPalette() {
  paletteOverlay.hidden = false;
  paletteInput.value = "";
  paletteInput.focus();
  renderPalette("");
}
function closePalette() { paletteOverlay.hidden = true; }

function renderPalette(query) {
  const actionsOnly = query.startsWith(">");
  const q = actionsOnly ? query.slice(1).trim() : query.trim();

  const actions = PALETTE_ACTIONS
    .map((a) => ({ kind: "action", label: a.label, run: a.run, score: fuzzyScore(q, a.label) }))
    .filter((a) => a.score >= 0);

  const notes = actionsOnly ? [] : graphData.nodes
    .filter((n) => n.exists)
    .map((n) => ({ kind: "note", label: n.id, type: n.type, score: fuzzyScore(q, n.id) }))
    .filter((n) => n.score >= 0)
    .sort((a, b) => b.score - a.score || (degree.get(b.label) || 0) - (degree.get(a.label) || 0))
    .slice(0, 12);

  paletteItems = q
    ? [...notes, ...actions.sort((a, b) => b.score - a.score).slice(0, 4)]
    : [...notes.slice(0, 8), ...actions];
  if (actionsOnly) paletteItems = actions.sort((a, b) => b.score - a.score);
  paletteIndex = 0;

  if (!paletteItems.length) {
    setHtml(paletteList, `<li class="p-none">Nothing matches "${esc(query)}"</li>`);
    return;
  }
  paletteList.replaceChildren(...paletteItems.map((item, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === paletteIndex));
    li.id = "palette-opt-" + i;
    if (item.kind === "note") {
      setHtml(li, `<span class="p-dot" style="background:${esc(typeColor(item.type))}"></span>` +
        `<span class="p-name">${esc(item.label)}</span><span class="p-type">${esc(item.type)}</span>`);
    } else {
      li.className = "p-action";
      setHtml(li, `<span class="p-dot" style="background:transparent"></span>` +
        `<span class="p-name">${esc(item.label)}</span><span class="p-type">action</span>`);
    }
    li.addEventListener("click", () => runPaletteItem(item));
    return li;
  }));
  paletteInput.setAttribute("aria-activedescendant", "palette-opt-0");
}

function runPaletteItem(item) {
  closePalette();
  if (item.kind === "note") {
    centerOn(item.label, 3.2);
    openNote(item.label);
  } else {
    item.run();
  }
}

paletteInput.addEventListener("input", () => renderPalette(paletteInput.value));
paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!paletteItems.length) return;
    paletteIndex = e.key === "ArrowDown"
      ? (paletteIndex + 1) % paletteItems.length
      : (paletteIndex - 1 + paletteItems.length) % paletteItems.length;
    [...paletteList.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === paletteIndex)));
    paletteInput.setAttribute("aria-activedescendant", "palette-opt-" + paletteIndex);
    paletteList.children[paletteIndex]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (paletteItems[paletteIndex]) runPaletteItem(paletteItems[paletteIndex]);
  }
});
paletteOverlay.addEventListener("click", (e) => { if (e.target === paletteOverlay) closePalette(); });
$("#rail-palette").addEventListener("click", openPalette);
$("#graph-search-btn").addEventListener("click", openPalette);

/* ---------------------------------------------------------------------------
   Global keyboard: Ctrl+K, Ctrl+., Esc stack
--------------------------------------------------------------------------- */
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    paletteOverlay.hidden ? openPalette() : closePalette();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === ".") {
    e.preventDefault();
    cycleFocusMode();
    return;
  }
  if (e.key === "Escape") {
    if (!paletteOverlay.hidden) { closePalette(); return; }
    if (dialog.open) { dialog.close(); pendingFiles = []; return; }
    if (!$("#slash-pop").hidden) { $("#slash-pop").hidden = true; return; }
    if (!$("#note-panel").hidden) { closeNotePanel(); return; }
    if (focusState) { exitFocusMode(); return; }
  }
});

/* ---------------------------------------------------------------------------
   Boot
--------------------------------------------------------------------------- */
function addWelcome() {
  addAssistantMsg(
    "Hi! I'm your vault librarian. Ask me anything about your knowledge base. " +
    "You start in **read-only** mode — tick **Edit** (top of this panel) to let me and the manual tools change the vault, " +
    "and to **drop files anywhere on this page** for filing. Only one session can hold Edit at a time.\n\n" +
    "Open a note and click **Focus in graph** (then pick a depth) to explore its neighborhood. " +
    "Try `/process-inbox`, `/audit`, or press **Ctrl+K** to jump to any note.",
    { save: false }
  );
}

setChatState("idle");
$("#session-dot").dataset.state = "";
loadGraph().then(() => {
  if (transcript.length) {
    for (const m of transcript) {
      if (m.r === "u") addUserMsg(m.t, { save: false });
      else addAssistantMsg(m.t, { save: false });
    }
    addStatus("restored from this browser — the librarian's memory may extend further back");
  } else {
    addWelcome();
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
});
autogrow();
