// Lists team documents that share a title, newest first. Read-only: it deletes
// nothing, so the user can remove the old ones from the Documents page.
//
//   node scripts/doc-duplicates.mjs [path/to/teams.json]
//
// The antistrat generator used to write a new document with the same title each
// time ("Outline: HAVU on Nuke"), and a team keeps a fixed number of documents,
// so old copies use up room. Titles now carry the date.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(here, '..', 'server', 'data', 'replays', 'teams.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const teams = Array.isArray(data) ? data : Array.isArray(data.teams) ? data.teams : Object.values(data.teams || data);

const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : 'undated');
let extra = 0;
for (const team of teams) {
  const byTitle = new Map();
  for (const d of team.documents || []) {
    const key = String(d.title || '').trim().toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(d);
  }
  const dupes = [...byTitle.values()].filter((l) => l.length > 1);
  if (!dupes.length) continue;
  console.log(`\n${team.name || team.id}: ${(team.documents || []).length} documents`);
  for (const list of dupes) {
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    console.log(`  "${list[0].title}" x${list.length}`);
    list.forEach((d, i) => console.log(`    ${i === 0 ? 'newest' : 'older '}  ${when(d.updatedAt)}  id ${d.id}  by ${d.updatedBy || d.authorName || '?'}`));
    extra += list.length - 1;
  }
}
console.log(extra ? `\n${extra} older copies could be deleted.` : 'No duplicate titles.');
