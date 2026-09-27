// ============================================================
// Guardrail: a migration that creates a table, view or materialized view in
// `public` must GRANT it explicitly, in the same file — and service_role must be
// among the grantees.
//
// From 2026-10-30 Supabase stops giving anon / authenticated / service_role
// automatic access to NEW objects in `public` (tables, views, and the sequences
// behind serial columns); https://github.com/orgs/supabase/discussions/45329.
// A table created without GRANTs is unreachable through the Data API: the apps
// and every Edge Function get `42501 permission denied for table x`. Existing
// tables keep their grants, so only new migrations are checked.
//
// Rules, per migration file numbered >= FIRST_CHECKED_MIGRATION:
//   1. CREATE [UNLOGGED] TABLE / [MATERIALIZED] VIEW in public (schema-qualified
//      or not; TEMP ignored) needs a GRANT ... ON <it>, or ON ALL TABLES IN SCHEMA
//      public placed after it, whose grantees include service_role (or PUBLIC).
//   2. A serial / DEFAULT nextval() column: every role granted INSERT on the table
//      also needs USAGE on that sequence (a table grant does not cover it).
//      GENERATED ... AS IDENTITY needs no sequence grant (measured on PG16).
//   3. Escape hatch, for a relation that must have no API access at all or for a
//      false positive of this parser: a line `-- grants-exempt: public.<name> <reason>`
//      in the same file.
// Known false positives (they fail loudly; use the escape hatch): CREATE OR REPLACE
// VIEW of a view that already exists (PostgreSQL keeps its grants), a staging table
// dropped or renamed in the same file, a partition of a granted parent, "create
// table" prose inside a string, a nextval() default on a sequence created earlier.
// Not seen (a GRANT is missing and the check passes): names built with dynamic SQL
// (skipped on purpose), SELECT ... INTO, ALTER TABLE ... ADD COLUMN serial or
// SET DEFAULT nextval() on an existing table, a REVOKE after the GRANT, a GRANT
// that only appears inside a string.
//
// The command line lives in scripts/check-migration-grants.mjs
// (pnpm check:migration-grants; tests: pnpm test:migration-grants).
// ============================================================

// When this check landed, no migration on master numbered 00587 or above created
// a table (00591-00597 don't), and 00587-00590 and 00593 were holes reserved by
// open PRs: #1004 creates four tables in 00587, so it gets checked when it merges.
// The older holes (00071, 00111, 00489, 00569) stay below the threshold; the only
// PR holding one, #965 (00569), just updates rows.
export const FIRST_CHECKED_MIGRATION = 587;

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;
const IDENT_CHAR = /[\w$\u0080-\uffff]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/y;
const CREATE_RE = new RegExp(
  String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(TEMP\s+|TEMPORARY\s+|UNLOGGED\s+)?` +
    String.raw`(?:RECURSIVE\s+)?(MATERIALIZED\s+VIEW|TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+|(?!IF\s+NOT\s+EXISTS\b))` +
    // The lookahead rejects a name that continues past what IDENT can read, so
    // format('CREATE TABLE public.%I ...') is skipped instead of read as public.public.
    String.raw`(${QUALIFIED})(?![\w$\u0080-\uffff"]|\s*\.)`,
  'gi',
);
const GRANT_RE = /\bGRANT\s+([^;]+?)\s+ON\s+([^;]+?)\s+TO\s+([^;]+?)\s*(?=;|$)/gi;
const EXEMPT_RE = new RegExp(String.raw`^[ \t]*--[ \t]*grants-exempt:[ \t]*(${QUALIFIED})[ \t]+(\S.*?)[ \t]*$`, 'gim');
const SERIAL_TYPES = new Set(['serial', 'serial4', 'bigserial', 'serial8', 'smallserial', 'serial2']);
const NON_RELATION_TARGETS = /^(FUNCTION|PROCEDURE|ROUTINE|SCHEMA|DATABASE|DOMAIN|FOREIGN|LANGUAGE|LARGE|PARAMETER|TABLESPACE|TYPE|ALL\s+(FUNCTIONS|PROCEDURES|ROUTINES))\b/i;

/** Leading digits of a migration filename (00059b_x.sql -> 59), or null. */
export function migrationNumber(file) {
  const m = /^(\d+)/.exec(file);
  return m ? Number.parseInt(m[1], 10) : null;
}

export function selectMigrationsToCheck(files) {
  return files
    .filter((f) => f.endsWith('.sql') && (migrationNumber(f) ?? -1) >= FIRST_CHECKED_MIGRATION)
    .sort();
}

/** PostgreSQL's name for the sequence of a serial column (ChooseRelationName + makeObjectName). */
export function serialSequenceName(table, column) {
  const avail = 63 - ('seq'.length + 1) - 1;
  let n1 = table.length;
  let n2 = column.length;
  while (n1 + n2 > avail) {
    if (n1 > n2) n1--;
    else n2--;
  }
  return `${table.slice(0, n1)}_${column.slice(0, n2)}_seq`;
}

/**
 * Blank out -- and (nested) block comments, keeping offsets and newlines; strings stay intact.
 * Dollar-quoted text ($$...$$, $function$...$function$) is lexed as code, because DO blocks
 * and function bodies are code, but no string, identifier or comment may run past the
 * closing tag of the innermost open quote. Without that bound, the apostrophe in a literal
 * like $m$the job's SQL$m$ (00597 has one) opened a "string" that swallowed the rest of
 * the file, and a commented-out GRANT further down counted as a real one.
 */
function maskComments(sql) {
  const out = sql.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const open = []; // dollar-quote tags currently open, innermost last
  const closer = (from) => {
    if (open.length === 0) return sql.length;
    const at = sql.indexOf(open[open.length - 1], from);
    return at === -1 ? sql.length : at;
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '$' && !IDENT_CHAR.test(sql[i - 1] ?? '')) {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(sql)?.[0];
      if (!tag) { i++; continue; }
      // A tag that is already open closes it, and anything opened inside it: PostgreSQL
      // ends a dollar quote at the first repeat of its tag, whatever lies in between.
      const level = open.lastIndexOf(tag);
      if (level === -1) open.push(tag);
      else open.length = level;
      i += tag.length;
    } else if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = Math.min(end === -1 ? sql.length : end, closer(i));
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const limit = closer(i);
      let depth = 0;
      let j = i;
      while (j < limit) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
        else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; if (depth === 0) break; }
        else j++;
      }
      j = Math.min(j, limit);
      blank(i, j);
      i = j;
    } else if (c === "'" || c === '"') {
      const limit = closer(i + 1);
      const backslashEscapes = c === "'" && /[eE]/.test(sql[i - 1] ?? '') && !IDENT_CHAR.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < limit) {
        if (backslashEscapes && sql[j] === '\\') j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      i = j < limit ? j + 1 : limit;
    } else {
      i++;
    }
  }
  return out.join('');
}

function normIdent(token) {
  return token.startsWith('"') ? token.slice(1, -1).replace(/""/g, '"') : token.toLowerCase();
}

/** "Public".foo / foo -> { schema, name } with PostgreSQL case folding. */
function parseQualified(text) {
  const m = new RegExp(String.raw`^\s*(${IDENT})(?:\s*\.\s*(${IDENT}))?\s*$`).exec(text);
  if (!m) return null;
  return m[2] ? { schema: normIdent(m[1]), name: normIdent(m[2]) } : { schema: 'public', name: normIdent(m[1]) };
}

const quoteIfNeeded = (id) => (/^[a-z_][a-z0-9_$]*$/.test(id) ? id : `"${id.replace(/"/g, '""')}"`);
const display = ({ schema, name }) => `${quoteIfNeeded(schema)}.${quoteIfNeeded(name)}`;
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

/** Top-level items of the parenthesised block that starts at `open` (quote-aware). */
function parenItems(text, open) {
  const items = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      i = close === -1 ? text.length : close;
    } else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) { items.push(text.slice(start, i)); return items; }
    } else if (c === ',' && depth === 1) {
      items.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return items;
}

/** Sequences a table's columns draw from: serial types and DEFAULT nextval('...'). */
function columnSequences(text, afterName, table) {
  const open = text.slice(afterName).search(/\S/);
  if (open === -1 || text[afterName + open] !== '(') return [];
  const seqs = [];
  for (const item of parenItems(text, afterName + open)) {
    const col = new RegExp(String.raw`^\s*(${IDENT})\s+(${IDENT})`).exec(item);
    if (!col || /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)$/i.test(col[1])) continue;
    const column = normIdent(col[1]);
    if (SERIAL_TYPES.has(col[2].toLowerCase())) {
      seqs.push({ column, seq: { schema: table.schema, name: serialSequenceName(table.name, column) } });
    }
    const nextval = /\bnextval\s*\(\s*'((?:[^']|'')+)'/i.exec(item);
    const seq = nextval && parseQualified(nextval[1].replace(/''/g, "'"));
    if (seq) seqs.push({ column, seq });
  }
  return seqs;
}

function parseGrant(match, text) {
  const statementStart = text.lastIndexOf(';', match.index) + 1;
  if (/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(text.slice(statementStart, match.index))) return null;
  const target = match[2].trim();
  if (NON_RELATION_TARGETS.test(target)) return null;

  const privileges = new Set(
    match[1].replace(/\([^)]*\)/g, ' ').split(',')
      .map((p) => p.trim().toUpperCase().replace(/\s+PRIVILEGES$/, ''))
      .filter(Boolean),
  );
  const grantees = new Set(
    match[3].split(/'|\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/)[0]
      .replace(/\s+WITH\s+GRANT\s+OPTION[\s\S]*$/i, '')
      .replace(/\s+GRANTED\s+BY[\s\S]*$/i, '')
      .split(',')
      .map((g) => g.trim().replace(/^GROUP\s+/i, ''))
      .filter((g) => new RegExp(String.raw`^${IDENT}$`).test(g))
      .map(normIdent)
      .map((g) => (g === 'public' ? 'PUBLIC' : g)), // PostgreSQL reads "public" quoted as PUBLIC too
  );
  const base = { offset: match.index, privileges, grantees };

  const all = /^ALL\s+(TABLES|SEQUENCES)\s+IN\s+SCHEMA\s+([\s\S]+)$/i.exec(target);
  if (all) {
    const schemas = all[2].split(',').map((s) => normIdent(s.trim()));
    return { ...base, scope: 'all', objectType: all[1].toLowerCase() === 'tables' ? 'table' : 'sequence', schemas };
  }
  const objects = /^(TABLE|SEQUENCE)\s+([\s\S]+)$/i.exec(target);
  const objectType = objects && objects[1].toUpperCase() === 'SEQUENCE' ? 'sequence' : 'table';
  const names = (objects ? objects[2] : target).split(',').map(parseQualified).filter(Boolean).map(display);
  return { ...base, scope: 'objects', objectType, names };
}

const granteesWith = (list, privs) =>
  new Set(list.filter((g) => privs.some((p) => g.privileges.has(p))).flatMap((g) => [...g.grantees]));

/**
 * Relations a migration creates in public and the grant problems found.
 * @returns {{ relations: {name,kind,line,exempt?}[], problems: {code,relation,kind,line,message,sequence?,column?,roles?}[] }}
 */
export function analyzeMigrationSql(sql) {
  const raw = sql.replace(/^\uFEFF/, '');
  const text = maskComments(raw);

  const exemptions = new Map();
  for (const m of raw.matchAll(EXEMPT_RE)) {
    const rel = parseQualified(m[1]);
    if (rel) exemptions.set(display(rel), m[2]);
  }

  const grantList = [...text.matchAll(GRANT_RE)].map((m) => parseGrant(m, text)).filter(Boolean);

  const relations = [];
  const problems = [];
  for (const m of text.matchAll(CREATE_RE)) {
    const persistence = (m[1] ?? '').trim().toUpperCase();
    if (persistence === 'TEMP' || persistence === 'TEMPORARY') continue;
    const rel = parseQualified(m[3]);
    if (!rel || rel.schema !== 'public') continue;

    const kind = m[2].toLowerCase().replace(/\s+/g, ' ');
    const name = display(rel);
    const line = lineAt(text, m.index);
    const relation = { name, kind, line };
    relations.push(relation);
    if (exemptions.has(name)) {
      relation.exempt = exemptions.get(name);
      continue;
    }

    const covering = grantList.filter((g) =>
      g.objectType === 'table' &&
      (g.scope === 'objects' ? g.names.includes(name) : g.schemas.includes('public') && g.offset > m.index));
    if (covering.length === 0) {
      problems.push({ code: 'no-grant', relation: name, kind, line,
        message: `${kind} ${name} — no GRANT in this migration` });
      continue;
    }
    if (!covering.some((g) => g.grantees.has('service_role') || g.grantees.has('PUBLIC'))) {
      problems.push({ code: 'no-service-role', relation: name, kind, line,
        message: `${kind} ${name} — GRANTed, but not to service_role (Edge Functions and scripts use it)` });
    }

    if (kind !== 'table') continue;
    const inserters = granteesWith(covering, ['INSERT', 'ALL']);
    for (const { column, seq } of columnSequences(text, m.index + m[0].length, rel)) {
      const seqName = display(seq);
      const usage = grantList.filter((g) =>
        (g.scope === 'objects' ? g.names.includes(seqName)
          : g.objectType === 'sequence' && g.schemas.includes(seq.schema) && g.offset > m.index));
      const users = granteesWith(usage, ['USAGE', 'UPDATE', 'ALL']);
      const roles = [...inserters].filter((r) => !users.has(r) && !users.has('PUBLIC')).sort();
      if (roles.length > 0) {
        problems.push({ code: 'sequence-usage', relation: name, kind, line, sequence: seqName, column, roles,
          message: `${kind} ${name} — column ${column} draws from ${seqName}, but ${roles.join(', ')} can INSERT without USAGE on it` });
      }
    }
  }
  return { relations, problems };
}
