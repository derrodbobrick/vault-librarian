// CLI: import a Smartsheet project plan into the vault as project + task + person notes.
//
//   node scripts/import-smartsheet.mjs            # stage to a temp dir (dry, safe)
//   node scripts/import-smartsheet.mjs --write     # write into the vault
//
// Reciprocal links into EXISTING notes (program, concepts, existing people) are
// done separately/manually for precision — this script only creates NEW files.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createClient, findSheet, getSheet, buildUserDirectory, mapSheet,
  renderProjectNote, renderTaskNote, renderPersonNote,
} from "../smartsheet.js";

const VAULT = process.env.VAULT_PATH || "C:/Users/james.derrod/Bobrick/Obsidian-knowledge-base";
const WRITE = process.argv.includes("--write");

const CFG = {
  sheetName: "3X8X Dynamic Program Creation BLA Pilot - v3",
  projectTitle: "3X8X Dynamic Program Creation BLA Pilot",
  program: "Spec2Saw",
  contextLinks: [
    { name: "Dynamic Program Creation", reason: "the capability this project builds" },
    { name: "3X8X Door Parametric Model", reason: "the component family it targets" },
  ],
  today: "2026-07-21",
};

const existingPeople = new Set(
  fs.readdirSync(path.join(VAULT, "Org")).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
);
CFG.existingPeople = existingPeople;

const outBase = WRITE ? VAULT : fs.mkdtempSync(path.join(os.tmpdir(), "ss-import-"));
const projectDir = path.join(outBase, "Projects", CFG.program, CFG.projectTitle);
const orgDir = path.join(outBase, "Org");
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(orgDir, { recursive: true });

const ss = createClient();
const sheetMeta = await findSheet(CFG.sheetName, ss);
if (!sheetMeta) throw new Error(`Sheet not found: ${CFG.sheetName}`);
const sheet = await getSheet(sheetMeta.id, ss);
const dir = await buildUserDirectory(ss);
const { project, tasks, people } = mapSheet(sheet, dir, CFG);

const write = (p, content) => { fs.writeFileSync(p, content); };

// project note
write(path.join(outBase, "Projects", CFG.program, `${project.name}.md`), renderProjectNote(project, people, CFG));

// task notes
let taskCount = 0;
for (const t of tasks) { write(path.join(projectDir, `${t.name}.md`), renderTaskNote(t, project, CFG)); taskCount++; }

// NEW person notes only (existing ones are updated separately)
const newPeople = [];
for (const p of people) {
  const note = renderPersonNote(p, project, CFG);
  if (note) { write(path.join(orgDir, `${p.name}.md`), note); newPeople.push(p); }
}

console.log(WRITE ? "WROTE INTO VAULT" : "STAGED (dry) at:\n  " + outBase);
console.log(`\nProject: ${project.name}  (${project.start} … ${project.due})`);
console.log(`Owner:   ${project.owner?.name} <${project.owner?.email}>`);
console.log(`Tasks:   ${taskCount}`);
console.log(`People referenced: ${people.length}  (new notes created: ${newPeople.length})`);
for (const p of people) {
  const isNew = newPeople.includes(p);
  const isExisting = existingPeople.has(p.name);
  console.log(`  ${isExisting ? "existing" : isNew ? "NEW     " : "??      "}  ${p.name}${p.email ? " <" + p.email + ">" : ""}`);
}
console.log(`\nStatus breakdown:`, tasks.reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {}));
console.log(`With dependencies: ${tasks.filter((t) => t.dependsOn.length).length}`);
if (!WRITE) console.log(`\nRe-run with --write to write into the vault at ${VAULT}`);
