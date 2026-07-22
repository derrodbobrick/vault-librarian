// Smartsheet integration for the Vault Librarian.
//
// One-way import: a Smartsheet sheet -> one project note + one task note per row,
// plus person notes for the people it references. Reusable by both the CLI
// importer (scripts) and the future /api/smartsheet/* endpoints.
//
// Auth: SMARTSHEET_ACCESS_TOKEN in the environment (loaded from .env, git-ignored).
import "dotenv/config";
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
  const fm = ["---", "type: task", `status: ${t.status}`, `priority: ${t.priority}`, "created: " + cfg.today];
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
