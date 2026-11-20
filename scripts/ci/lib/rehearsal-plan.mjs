// Which migration rehearsals a PR must run, from its changed files:
//   - every migration the PR adds (or renames and edits): RED (`run.sh none` must fail) and GREEN
//     (`run.sh <migration>` must pass);
//   - every migration the PR changes, and every rehearsal folder it changes for a migration it
//     does not add: GREEN only;
//   - a pure rename (same blob, the renumbering of a collision) is not new: nothing runs.
// A new migration without supabase/tests/<number>/run.sh is an error, unless its first line is
// `-- rehearsal-exempt: <reason>` with a reason of 10+ characters. A file under
// supabase/migrations/ whose name is not `<number>_<name>.sql` is an error: no check would see it.

const MIGRATION = /^supabase\/migrations\/(\d+[a-z]?)_[^/]+\.sql$/;
const IN_MIGRATIONS = /^supabase\/migrations\//;
const REHEARSAL = /^supabase\/tests\/(\d+[a-z]?)\//;
const EXEMPT = /^﻿?--[ \t]*rehearsal-exempt:[ \t]*(.+?)[ \t]*$/;

// changes: changedFiles(fork, head) WITH renames ({ status, path, oldPath?, oldBlob, newBlob }).
// headFiles: Set of paths at the head (migrations and rehearsals at least).
// firstLine(path): the first line of a file at the head, or null.
export function planRehearsals(changes, headFiles, firstLine) {
  const runs = [];
  const errors = [];
  const notices = [];
  const byNumber = new Map();
  for (const path of headFiles) {
    const m = MIGRATION.exec(path);
    if (m) byNumber.set(m[1], [...(byNumber.get(m[1]) ?? []), path]);
  }
  const runnerOf = (number) => `supabase/tests/${number}/run.sh`;

  const planned = new Set();
  const added = [];
  const changed = [];
  for (const change of changes) {
    if (change.status === 'D' || !IN_MIGRATIONS.test(change.path)) continue;
    if (!MIGRATION.test(change.path)) {
      errors.push(`${change.path} does not follow the name supabase/migrations/<number>_<name>.sql, so no check would see it. Rename it.`);
      continue;
    }
    const pureRename =
      change.status === 'R' && Boolean(change.oldBlob) && change.oldBlob === change.newBlob && MIGRATION.test(change.oldPath ?? '');
    if (pureRename) continue;
    (change.status === 'M' || change.status === 'T' ? changed : added).push(change.path);
  }

  for (const path of added.sort()) {
    const number = MIGRATION.exec(path)[1];
    planned.add(number);
    const runner = runnerOf(number);
    const exempt = EXEMPT.exec(firstLine(path) ?? '');
    if (headFiles.has(runner)) {
      runs.push({ number, migration: path, runner, red: true });
    } else if (exempt && exempt[1].length >= 10) {
      notices.push(`${path}: no rehearsal (${exempt[1]}).`);
    } else {
      errors.push(
        `${path} has no rehearsal. Add ${runner} (copy supabase/tests/_template/), or make its first line "-- rehearsal-exempt: <reason>".`,
      );
    }
  }

  for (const path of changed.sort()) {
    const number = MIGRATION.exec(path)[1];
    if (planned.has(number)) continue;
    planned.add(number);
    const runner = runnerOf(number);
    if (headFiles.has(runner)) runs.push({ number, migration: path, runner, red: false });
    else notices.push(`${path} changed and has no runner (${runner}), so nothing rehearses it.`);
  }

  const touched = new Set();
  for (const change of changes) {
    const m = REHEARSAL.exec(change.path);
    if (m && !planned.has(m[1])) touched.add(m[1]);
  }
  for (const number of [...touched].sort()) {
    const runner = runnerOf(number);
    if (!headFiles.has(runner)) continue;
    const migrations = byNumber.get(number) ?? [];
    if (migrations.length !== 1) {
      notices.push(`${runner}: ${migrations.length} migrations carry number ${number}, not rehearsed.`);
      continue;
    }
    runs.push({ number, migration: migrations[0], runner, red: false });
  }

  runs.sort((a, b) => a.number.localeCompare(b.number));
  return { runs, errors, notices };
}
