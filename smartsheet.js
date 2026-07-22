// Smartsheet integration for the Vault Librarian.
//
// One-way import: a Smartsheet sheet -> one project note + one task note per row,
// plus person notes for the people it references. Reusable by both the CLI
// importer (scripts) and the future /api/smartsheet/* endpoints.
//
// Auth: SMARTSHEET_ACCESS_TOKEN in the environment (loaded from .env, git-ignored).
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import client from "smartsheet";

const SHEET_INCLUDES =
  "discussions,objectValue,rowPermalink,source,columnType,ownerInfo";

export function createClient() {
  const accessToken = process.env.SMARTSHEET_ACCESS_TOKEN;
  if (!accessToken) throw new Error("SMARTSHEET_ACCESS_TOKEN is not set (see .env / .env.example)");
  // NB: SDK v5 wants a real Winston level; 'silent' throws — use 'error'.
  return client.createClient({ accessToken, logLevel: "error" });
}

export async function listSheets(ss = createClient()) {
  const r = await ss.sheets.listSheets({ queryParameters: { includeAll: true } });
  return r.data; // [{id,name,permalink,createdAt,modifiedAt,...}]
}

export async function findSheet(name, ss = createClient()) {
  const sheets = await listSheets(ss);
  return sheets.find((s) => s.name === name) || sheets.find((s) => s.name.includes(name)) || null;
}

export async function getSheet(id, ss = createClient()) {
  return ss.sheets.getSheet({ id, queryParameters: { include: SHEET_INCLUDES } });
}

// Directory of org users -> email lookups by lowercased "First Last" and by email.
export async function buildUserDirectory(ss = createClient()) {
  const byName = new Map();
  const byEmail = new Map();
  try {
    const r = await ss.users.listAllUsers({ queryParameters: { includeAll: true } });
    for (const u of r.data) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
      if (name) byName.set(name.toLowerCase(), { name, email: u.email });
      if (u.email) byEmail.set(u.email.toLowerCase(), { name, email: u.email });
    }
  } catch { /* non-admin or unavailable — fall back to cell emails only */ }
  return { byName, byEmail };
}

// ---- mapping helpers -------------------------------------------------------

const STATE_MAP = { backlog: "todo", "not started": "todo", doing: "in-progress", "in progress": "in-progress", blocked: "blocked", done: "done", complete: "done", cancelled: "cancelled" };

export function titleCaseEmailLocalPart(email) {
  return email.split("@")[0].split(/[._-]+/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

// Resolve a raw "Responsible" cell value to [{name,email}] (splits multi-person cells).
export function resolvePeople(raw, dir) {
  if (!raw) return [];
  return String(raw)
    .split(/[,;/&]| and /i)
    .map((s) => s.trim())
    .filter((s) => s && !/^(tbd|n\/?a|none)$/i.test(s))
    .map((token) => {
      const clean = token.replace(/\(external\)/i, "").trim();
      if (clean.includes("@")) {
        const email = clean.toLowerCase();
        return dir.byEmail.get(email) || { name: titleCaseEmailLocalPart(clean), email };
      }
      const hit = dir.byName.get(clean.toLowerCase());
      if (hit) return hit;
      // first-name-only match (e.g. "Nikolas" -> "Nikolas Rush") when unambiguous
      if (!/\s/.test(clean)) {
        const starts = [...dir.byName.values()].filter((u) => u.name.toLowerCase().startsWith(clean.toLowerCase() + " "));
        if (starts.length === 1) return starts[0];
      }
      return { name: clean, email: null };
    })
    .filter((p) => p.name);
}

function sanitizeName(title) {
  let t = String(title).replace(/[<>:"/\\|?*\[\]#^]+/g, " ").replace(/\s+/g, " ").trim();
  if (t.length > 70) {
    const cut = t.slice(0, 70);
    const sp = cut.lastIndexOf(" ");
    t = (sp > 30 ? cut.slice(0, sp) : cut).trim() + "…";
  }
  return t || "Task";
}

const isoDate = (s) => (s ? String(s).slice(0, 10) : "");

// Turn a fetched sheet into { project, tasks, people } — pure, writes nothing.
export function mapSheet(sheet, dir, cfg) {
  const col = {};
  for (const c of sheet.columns) col[c.title] = c.id;
  const cell = (row, title) => (row.cells || []).find((c) => c.columnId === col[title]);
  const val = (row, title) => { const c = cell(row, title); return c ? (c.displayValue ?? c.value ?? "") : ""; };
  const rowById = new Map(sheet.rows.map((r) => [r.id, r]));

  // Skip blank rows (no Task title) — they are spacer/placeholder rows and would
  // otherwise become empty "Row N" notes that clutter the graph.
  const rows = sheet.rows.filter((r) => String(val(r, "Task")).trim());
  const includedIds = new Set(rows.map((r) => r.id));

  // Assign each included row a unique note name up-front so links can target it.
  const used = new Map();
  const nameFor = (row) => {
    let base = sanitizeName(val(row, "Task"));
    if (used.has(base.toLowerCase())) base = `${base} (${row.rowNumber})`;
    used.set(base.toLowerCase(), true);
    return base;
  };
  const noteName = new Map();
  for (const r of rows) noteName.set(r.id, nameFor(r));

  const peopleMap = new Map(); // name -> {name,email}
  const remember = (p) => {
    if (!p) return p;
    const existing = peopleMap.get(p.name);
    if (existing) { if (!existing.email && p.email) existing.email = p.email; return existing; }
    peopleMap.set(p.name, { ...p });
    return peopleMap.get(p.name);
  };

  const tasks = rows.map((r) => {
    const state = String(val(r, "State")).toLowerCase();
    const pct = String(val(r, "% Complete")).replace("%", "").trim();
    let status = STATE_MAP[state] || "";
    if (!status) status = pct === "100" ? "done" : (Number(pct) > 0 ? "in-progress" : "todo");

    const assignees = resolvePeople(val(r, "Responsible"), dir).map(remember);
    const predCell = cell(r, "Predecessors");
    const preds = (predCell?.objectValue?.predecessors || [])
      .filter((p) => includedIds.has(p.rowId))
      .map((p) => noteName.get(p.rowId));

    return {
      name: noteName.get(r.id),
      rowId: r.id, rowNumber: r.rowNumber, level: String(val(r, "Level")),
      title: (val(r, "Task") || `Row ${r.rowNumber}`).replace(/\s+/g, " ").trim(),
      status, priority: "medium",
      assignees,
      scheduled: isoDate(val(r, "Start")), due: isoDate(val(r, "Finish")),
      duration: val(r, "Duration"), pct: val(r, "% Complete"),
      sprint: val(r, "Sprint"), allocation: val(r, "Allocation %"), notes: val(r, "Notes"),
      parent: r.parentId && includedIds.has(r.parentId) ? noteName.get(r.parentId) : null,
      dependsOn: preds,
      permalink: r.permalink,
    };
  });

  // owner
  const owner = dir.byEmail.get((sheet.owner || "").toLowerCase()) ||
    (sheet.owner ? { name: titleCaseEmailLocalPart(sheet.owner), email: sheet.owner } : null);
  if (owner) remember(owner);

  const allDates = tasks.flatMap((t) => [t.scheduled, t.due]).filter(Boolean).sort();
  const project = {
    name: cfg.projectTitle,
    owner,
    program: cfg.program,
    contextLinks: cfg.contextLinks || [],
    start: allDates[0] || "", due: allDates[allDates.length - 1] || "",
    sheetId: sheet.id, permalink: sheet.permalink, sheetName: sheet.name,
  };

  return { project, tasks, people: [...peopleMap.values()] };
}

// ---- note rendering --------------------------------------------------------

const fmList = (arr) => `[${arr.map((x) => `"[[${x}]]"`).join(", ")}]`;

export function renderProjectNote(project, people, cfg) {
  const fm = ["---", "type: project", "status: active", "priority: high", "created: " + cfg.today];
  if (project.start) fm.push("start: " + project.start);
  if (project.due) fm.push("due: " + project.due);
  if (project.owner) fm.push(`owner: "[[${project.owner.name}]]"`);
  fm.push("source: smartsheet", "smartsheet_sheet_id: " + project.sheetId,
    `smartsheet_permalink: ${project.permalink}`, "tags: [spec2saw, smartsheet]", "---", "");
  const body = [`# ${project.name}`, "",
    `Project plan for the 3X8X dynamic program creation BLA pilot, imported from the Smartsheet "${project.sheetName}" (owner ${project.owner?.name || "unknown"}). Tasks are the notes in this project's folder; statuses, dates, owners, and dependencies come from the sheet.`, "",
    "## People", ""];
  for (const p of people) {
    const role = project.owner && p.name === project.owner.name ? "project owner (Smartsheet sheet owner)" : "works on this project (from the plan)";
    body.push(`- [[${p.name}]] — ${role}`);
  }
  body.push("", "## Related", "",
    `- [[${project.program}]] — program this project belongs to (R9 containment)`);
  for (const c of project.contextLinks) body.push(`- [[${c.name}]] — ${c.reason} (R12)`);
  return fm.join("\n") + body.join("\n") + "\n";
}

export function renderTaskNote(t, project, cfg) {
  const fm = ["---", "type: task", `status: ${t.status}`, `priority: ${t.priority}`,
    "created: " + (t.created || cfg.today)];
  if (t.due) fm.push("due: " + t.due);
  if (t.scheduled) fm.push("scheduled: " + t.scheduled);
  fm.push(`project: "[[${project.name}]]"`);
  if (t.parent) fm.push(`parent: "[[${t.parent}]]"`);
  if (t.assignees.length === 1) fm.push(`assignee: "[[${t.assignees[0].name}]]"`);
  else if (t.assignees.length > 1) fm.push(`assignee: ${fmList(t.assignees.map((a) => a.name))}`);
  if (t.dependsOn.length) fm.push(`depends-on: ${fmList(t.dependsOn)}`);
  fm.push("source: smartsheet", "smartsheet_sheet_id: " + project.sheetId,
    "smartsheet_row_id: " + t.rowId, "tags: [spec2saw, smartsheet]", "---", "");
  const body = [`# ${t.title}`, ""];
  const plan = [];
  if (t.pct) plan.push(`- % complete: ${t.pct}`);
  if (t.duration) plan.push(`- Duration: ${t.duration}`);
  if (t.sprint) plan.push(`- Sprint: ${t.sprint}`);
  if (t.allocation) plan.push(`- Allocation: ${t.allocation}`);
  if (plan.length) body.push("## Plan", ...plan, "");
  if (t.notes) body.push("## Notes", t.notes, "");
  body.push("## Related", `- [[${t.parent || project.name}]] — parent in the project plan`);
  return fm.join("\n") + body.join("\n") + "\n";
}

export function renderPersonNote(p, project, cfg) {
  const known = cfg.existingPeople?.has(p.name);
  if (known) return null; // existing notes are updated in place, not overwritten
  const fm = ["---", "type: person", "status: seed", "created: " + cfg.today];
  if (p.email) fm.push("email: " + p.email);
  fm.push("tags: [people, spec2saw, smartsheet]", "---", "");
  const role = project.owner && p.name === project.owner.name ? "the project owner" : "a contributor";
  const body = [`# ${p.name}`, "",
    `Works on [[${project.name}]] as ${role} (from the Smartsheet project plan). Outside the OT department.`, "",
    "## Related", `- [[${project.name}]] — ${role} on this project`];
  return fm.join("\n") + body.join("\n") + "\n";
}

// ---- import to the vault (with row-id upsert) ------------------------------

const IGNORE_DIRS = new Set([".obsidian", ".claude", ".git", ".trash", "OT Dashboard"]);

// Map every existing task note's smartsheet_row_id -> its absolute path, so a
// re-import updates the same note instead of creating a duplicate.
export function indexTasksByRowId(vault) {
  const idx = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) walk(p); }
      else if (e.name.endsWith(".md")) {
        const m = fs.readFileSync(p, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const r = m && m[1].match(/^smartsheet_row_id:\s*(\d+)/m);
        if (r) idx.set(r[1], p);
      }
    }
  };
  walk(vault);
  return idx;
}

// Import a Smartsheet sheet into the vault as project + task + person notes.
// Upserts tasks by smartsheet_row_id (renaming on title change so links resolve),
// and never clobbers an existing project or person note (preserves manual edits
// such as R12 concept links). Returns a summary.
export async function importToVault({ sheetId, sheetName, vault, cfg, ss }) {
  ss = ss || createClient();
  let meta = sheetId ? { id: sheetId } : await findSheet(sheetName, ss);
  if (!meta) throw new Error("Smartsheet sheet not found");
  const sheet = await getSheet(meta.id, ss);
  const dir = await buildUserDirectory(ss);
  const { project, tasks, people } = mapSheet(sheet, dir, cfg);

  cfg.existingPeople = new Set(
    fs.readdirSync(path.join(vault, "Org")).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
  );
  const rowIdx = indexTasksByRowId(vault);

  const programDir = path.join(vault, "Projects", cfg.program);
  const projectDir = path.join(programDir, project.name);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(vault, "Org"), { recursive: true });

  // Project note: create only if absent (preserve manual curation on re-import).
  const projPath = path.join(programDir, project.name + ".md");
  let projectCreated = false;
  if (!fs.existsSync(projPath)) { fs.writeFileSync(projPath, renderProjectNote(project, people, cfg)); projectCreated = true; }

  let created = 0, updated = 0;
  for (const t of tasks) {
    const desired = path.join(projectDir, t.name + ".md");
    const existing = rowIdx.get(String(t.rowId));
    if (existing) {
      // preserve the original creation date across re-imports
      const fmm = fs.readFileSync(existing, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const cm = fmm && fmm[1].match(/^created:\s*(.+)$/m);
      if (cm) t.created = cm[1].trim();
    }
    fs.writeFileSync(desired, renderTaskNote(t, project, cfg));
    if (existing) {
      updated++;
      if (path.resolve(existing) !== path.resolve(desired)) {
        try { fs.unlinkSync(existing); } catch { /* renamed on title change */ }
      }
    } else {
      created++;
    }
  }

  let newPeople = 0;
  for (const p of people) {
    const note = renderPersonNote(p, project, cfg);
    if (note) { fs.writeFileSync(path.join(vault, "Org", p.name + ".md"), note); newPeople++; }
  }

  return {
    project: project.name, program: cfg.program, sheetId: meta.id, sheetName: sheet.name,
    tasks: tasks.length, created, updated, newPeople, projectCreated,
  };
}
