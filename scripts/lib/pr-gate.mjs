// Rules of the PR gate (scripts/check-pr.mjs), as pure functions over the PR description, the
// changed files and the review areas, so every rule is unit tested without git. Each check
// returns { errors: [], warnings: [] }.

// The sections of .github/pull_request_template.md, in order (a test keeps them equal).
export const SECTIONS = [
  'What changes',
  'Why',
  'How it was validated',
  'Tests',
  'Review areas',
  'Cross-review',
  'Native and OTA',
  'Migrations',
  'Final check',
];

const MIGRATION = /^supabase\/migrations\/(\d+[a-z]?)_[^/]+\.sql$/;
const SOURCE = [/^packages\/[^/]+\/src\//, /^apps\/[^/]+\/(src|app)\//, /^supabase\/functions\//, /^supabase\/migrations\//];
const TEST = [/(^|\/)__tests__\//, /\.test\.(ts|tsx|js|mjs)$/, /^supabase\/tests\//, /(^|\/)\.maestro\//];
const VERDICT = /^[ \t]*Cross-review:[ \t]+(APPROVED|APPROVED_WITH_RESERVATIONS|FIX_CONFIRMED)[ \t]+(\S+)[ \t]+([0-9a-f]{40})[ \t]*$/gm;
const EMPTY_FENCE = /^[ \t]*(```|~~~)[^\n]*\n(?:[ \t]*\n)*[ \t]*\1[ \t]*$/gm;
const BOX = /^[ \t]*[-*][ \t]+\[([ xX])\]/gm;
const MIN_REASON = 10;

const result = (errors = [], warnings = []) => ({ errors, warnings });
const realReason = (text) => text.length >= MIN_REASON && !/^<.*>$/.test(text);

// The description without HTML comments (the template keeps its placeholders inside them). An
// unclosed comment hides everything after it, so text after a broken comment never counts.
export function stripComments(body) {
  return String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '');
}

// Map(heading -> content) of the `## ` sections, in order.
export function parseSections(body) {
  const sections = new Map();
  let current = null;
  for (const line of stripComments(body).split('\n')) {
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (heading) {
      current = heading[1];
      sections.set(current, []);
    } else if (current !== null) {
      sections.get(current).push(line);
    }
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join('\n')]));
}

export function isEmptySection(text) {
  return text.replace(EMPTY_FENCE, '').trim() === '';
}

function boxes(text) {
  return [...text.matchAll(BOX)].map((m) => m[1] !== ' ');
}

export function checkDescription(body) {
  const errors = [];
  const sections = parseSections(body);
  for (const name of SECTIONS) {
    if (!sections.has(name)) errors.push(`The description has no "## ${name}" section.`);
    else if (isEmptySection(sections.get(name))) errors.push(`The "## ${name}" section is empty.`);
  }
  if (sections.has('Native and OTA')) {
    const ticked = boxes(sections.get('Native and OTA')).filter(Boolean).length;
    if (ticked !== 1) errors.push(`Tick exactly one box in "## Native and OTA" (ticked: ${ticked}).`);
  }
  if (sections.has('Final check')) {
    const all = boxes(sections.get('Final check'));
    if (all.length === 0 || all.some((ticked) => !ticked)) errors.push('Tick every box in "## Final check".');
  }
  return result(errors);
}

// The reason after `label:` on a line of its own, outside comments. Null when the line is
// missing, the reason is shorter than 10 characters, or it is still the template placeholder.
export function reasonFor(body, label) {
  const match = new RegExp(`^[ \\t]*${label}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(stripComments(body));
  return match && realReason(match[1]) ? match[1] : null;
}

// `Migration edit: <path> <reason>` lines: Map(path -> reason), real reasons only.
export function migrationEdits(body) {
  const edits = new Map();
  for (const m of stripComments(body).matchAll(/^[ \t]*Migration edit:[ \t]+(\S+)[ \t]+(.+?)[ \t]*$/gm)) {
    if (realReason(m[2])) edits.set(m[1], m[2]);
  }
  return edits;
}

// The last valid `Cross-review: <verdict> <work-id> <sha>` line (round 2 comes after round 1).
export function latestVerdict(body) {
  const all = [...stripComments(body).matchAll(VERDICT)];
  if (all.length === 0) return null;
  const [, verdict, workId, sha] = all[all.length - 1];
  return { verdict, workId, sha };
}

const isTest = (path) => TEST.some((re) => re.test(path));
const isSource = (path) => !isTest(path) && SOURCE.some((re) => re.test(path));

// changes: [{ status, path }] (plain paths count as modified). A deleted test does not count.
export function checkTests(changes, body) {
  const all = changes.map((change) => (typeof change === 'string' ? { status: 'M', path: change } : change));
  const sources = all.map((change) => change.path).filter(isSource);
  const hasTest = all.some((change) => change.status !== 'D' && isTest(change.path));
  if (sources.length === 0 || hasTest || reasonFor(body, 'No tests because')) return result();
  const listed = sources.slice(0, 3).join(', ') + (sources.length > 3 ? ', …' : '');
  return result([
    `This PR changes source (${listed}) and no test. Add a test that fails without the change, or a line "No tests because: <reason>".`,
  ]);
}

// changes: changedFiles(fork, head) with renames (it carries the blob ids). baseMigrations:
// migration paths at the merge base (what the PR may not edit). masterMigrations: migration paths
// on master as it is now (the numbers taken); defaults to baseMigrations. openPrs:
// [{ number, files: [path] }] of the open PRs (this one included or not).
export function checkMigrations({ changes, baseMigrations, masterMigrations = baseMigrations, body, prNumber = Infinity, openPrs = [] }) {
  const errors = [];
  const edits = migrationEdits(body);
  const onBase = new Set(baseMigrations);
  const leaving = new Set();
  const added = [];
  for (const change of changes) {
    if (change.status !== 'D' && change.path.startsWith('supabase/migrations/') && !MIGRATION.test(change.path)) {
      errors.push(
        `${change.path} does not follow the name supabase/migrations/<number>_<name>.sql, so the migration checks would not see it. Rename it.`,
      );
    }
    const old = change.oldPath ?? change.path;
    if (onBase.has(old) && MIGRATION.test(old)) {
      if (change.status === 'R' || change.status === 'D') leaving.add(old);
      const movedOut = change.status === 'R' && !MIGRATION.test(change.path);
      const sameContent = Boolean(change.oldBlob) && change.oldBlob === change.newBlob;
      const pureRename = change.status === 'R' && !movedOut && sameContent;
      const keepsOld = change.status === 'A' || change.status === 'C';
      if (!pureRename && !keepsOld && !edits.has(old)) {
        const verb = change.status === 'D' ? 'deletes' : movedOut ? 'moves it out of supabase/migrations/, which deletes' : 'changes';
        errors.push(
          `${old} is already on master and this PR ${verb} it. Write a new migration instead, or add a line "Migration edit: ${old} <reason>".`,
        );
      }
    }
    if (['A', 'R', 'C'].includes(change.status) && MIGRATION.test(change.path) && !onBase.has(change.path)) {
      added.push(change.path);
    }
  }
  const numberOf = (path) => MIGRATION.exec(path)[1];
  const masterNumbers = new Map();
  for (const path of masterMigrations) {
    if (MIGRATION.test(path) && !leaving.has(path)) masterNumbers.set(numberOf(path), path);
  }
  const addedByNumber = new Map();
  for (const path of added) addedByNumber.set(numberOf(path), [...(addedByNumber.get(numberOf(path)) ?? []), path]);
  for (const [number, paths] of addedByNumber) {
    if (paths.length > 1) errors.push(`Number ${number} is used twice in this PR: ${paths.join(', ')}.`);
  }
  for (const path of added) {
    const number = numberOf(path);
    if (masterNumbers.has(number)) {
      errors.push(`${path}: number ${number} is already used on master by ${masterNumbers.get(number)}. Take the next free number.`);
    }
    for (const pr of openPrs) {
      if (!(pr.number < prNumber)) continue;
      const taken = (pr.files ?? []).find(
        (file) => MIGRATION.test(file) && !onBase.has(file) && !masterNumbers.has(numberOf(file)) && numberOf(file) === number,
      );
      if (taken) errors.push(`${path}: number ${number} is taken by the older open PR #${pr.number} (${taken}). The older PR keeps it.`);
    }
  }
  return result(errors);
}

// areas: what the PR touches (union of both maps). verdict: latestVerdict(body). required: the
// base map's crossReview.required. reviewedIsAncestor: the reviewed sha is a commit of this PR.
// sensitiveAfterReview: files of a review area changed between the reviewed sha and the head.
export function checkCrossReview({ areas, verdict, required, reviewedIsAncestor = false, sensitiveAfterReview = [] }) {
  if (areas.length === 0) return result();
  const problems = [];
  if (!verdict) {
    problems.push(`This PR touches ${areas.map((a) => a.id).join(', ')} and the description has no "Cross-review: <verdict> <work-id> <sha>" line.`);
  } else if (!reviewedIsAncestor) {
    problems.push(`The reviewed commit ${verdict.sha.slice(0, 12)} is not in this PR.`);
  } else if (sensitiveAfterReview.length > 0) {
    problems.push(
      `These files of a review area changed after the review at ${verdict.sha.slice(0, 12)}: ${sensitiveAfterReview.join(', ')}. Run round 2 and paste its line.`,
    );
  }
  if (required) return result(problems);
  return result([], problems.map((p) => `${p} (not enforced yet: the cross-review becomes required in part 3)`));
}
