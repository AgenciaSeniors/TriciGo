// Which migration rehearsals a PR must run, from its changed files:
//   - every migration the PR adds: RED (`run.sh none` must fail) and GREEN (`run.sh <migration>`
//     must pass);
//   - every rehearsal folder the PR changes, for a migration it does not add: GREEN only.
// A new migration without supabase/tests/<number>/run.sh is an error, unless its first line is
// `-- rehearsal-exempt: <reason>` with a reason of 10+ characters.

const MIGRATION = /^supabase\/migrations\/(\d+[a-z]?)_[^/]+\.sql$/;
const REHEARSAL = /^supabase\/tests\/(\d+[a-z]?)\//;
const EXEMPT = /^--[ \t]*rehearsal-exempt:[ \t]*(.+?)[ \t]*$/;

// changes: [{ status, path }] without renames. headFiles: Set of paths at the head (migrations and
// rehearsals at least). firstLine(path): the first line of a file at the head, or null.
export function planRehearsals(changes, headFiles, firstLine) {
  const runs = [];
  const errors = [];
  const notices = [];
  const byNumber = new Map();
  for (const path of headFiles) {
    const m = MIGRATION.exec(path);
    if (m) byNumber.set(m[1], [...(byNumber.get(m[1]) ?? []), path]);
  }

  const added = new Set();
  for (const change of changes) {
    if (change.status !== 'A' || !MIGRATION.test(change.path)) continue;
    const number = MIGRATION.exec(change.path)[1];
    added.add(number);
    const runner = `supabase/tests/${number}/run.sh`;
    const exempt = EXEMPT.exec(firstLine(change.path) ?? '');
    if (headFiles.has(runner)) {
      runs.push({ number, migration: change.path, runner, red: true });
    } else if (exempt && exempt[1].length >= 10) {
      notices.push(`${change.path}: no rehearsal (${exempt[1]}).`);
    } else {
      errors.push(
        `${change.path} has no rehearsal. Add ${runner} (copy supabase/tests/_template/), or make its first line "-- rehearsal-exempt: <reason>".`,
      );
    }
  }

  const touched = new Set();
  for (const change of changes) {
    const m = REHEARSAL.exec(change.path);
    if (m && !added.has(m[1])) touched.add(m[1]);
  }
  for (const number of [...touched].sort()) {
    const runner = `supabase/tests/${number}/run.sh`;
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
