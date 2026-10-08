// ============================================================
// Guardrail: TriciGo copy is tuteo (tú), never voseo.
//
// The repo-wide sweep of 2026-07-31 left the apps in tuteo, and by
// 2026-10-07 voseo was back in about 40 app strings and the e-mail
// templates ("Revisá tu correo", "Llamá al 106", "Seguinos", "¿Fuiste
// vos?"): new copy imitates the surrounding style, and nothing checked it.
// This test scans the Spanish copy the apps ship and fails on a voseo form:
//   - every string in packages/i18n/src/locales/es/*.json,
//   - string literals, template-literal text and JSX text in the apps and
//     packages (defaultValue strings included; comments are not copy and
//     are skipped),
//   - the store listings in apps/*/store-metadata/es and GoTrue's e-mail
//     templates (supabase/templates, the subjects in supabase/config.toml),
//   - string literals in SQL migrations from 00639 on, function bodies
//     included: push, SMS and e-mail text built by trigger functions, and
//     RAISE messages the apps show. Two pushes ("Intentalo nuevamente",
//     "Abrí la app y confirmá si lo ves") lived in prod functions for months
//     because nothing read SQL; 00638 fixed them.
// Copy that admins edit in prod (CMS pages, blog, announcements) never goes
// through git, so this test cannot see it.
//
// The forms are generated from a list of verbs instead of being listed one
// by one, so a verb used in new copy is covered in every voseo shape:
// present ("podés"), imperative ("revisá"), imperative with a pronoun
// ("intentalo", "seguinos") and present without its accent ("tenes").
// Left out on purpose, because they are also valid Spanish:
//   - the -ir imperative ("pedí", "escribí", "abrí"): it is spelled like the
//     first-person preterite ("Pedí por error", "Le escribí"), so only
//     "decí" and "vení", whose preterites are "dije" and "vine", are banned;
//   - forms of estar ("estás" is tuteo too), "tomás" (Tomás) and
//     "tomate" (the vegetable).
// When a new voseo word slips through, add its verb to the list below.
// ============================================================

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const AR = [
  'aceptar', 'acercar', 'acordar', 'activar', 'actualizar', 'agregar', 'ajustar', 'anotar',
  'apretar', 'asegurar', 'avisar', 'borrar', 'buscar', 'calificar', 'cambiar', 'cancelar',
  'cargar', 'cerrar', 'chequear', 'completar', 'comprobar', 'conectar', 'confirmar', 'conservar',
  'consultar', 'contactar', 'contar', 'copiar', 'dejar', 'desactivar', 'descargar',
  'desconectar', 'editar', 'encontrar', 'enviar', 'esperar', 'explicar', 'fijar', 'guardar',
  'habilitar', 'ingresar', 'intentar', 'invitar', 'llamar', 'llenar', 'llevar', 'mandar',
  'marcar', 'mirar', 'necesitar', 'olvidar', 'pagar', 'pasar', 'presionar', 'probar',
  'programar', 'quedar', 'recargar', 'recordar', 'regalar', 'registrar', 'reintentar',
  'reportar', 'reservar', 'retirar', 'revisar', 'sentar', 'solicitar', 'sumar', 'tocar',
  'tomar', 'ubicar', 'usar', 'validar', 'verificar',
];
const ER = [
  'aparecer', 'conocer', 'correr', 'creer', 'deber', 'devolver', 'encender', 'entender',
  'escoger', 'establecer', 'hacer', 'leer', 'mantener', 'mover', 'obtener', 'ofrecer',
  'perder', 'poder', 'poner', 'prometer', 'proteger', 'querer', 'recoger', 'reconocer',
  'responder', 'saber', 'tener', 'volver',
];
const IR = [
  'abrir', 'añadir', 'compartir', 'cumplir', 'decir', 'describir', 'elegir', 'escribir',
  'imprimir', 'pedir', 'permitir', 'recibir', 'salir', 'seguir', 'subir', 'venir',
];
// -er verbs whose tú present changes the stem (tienes, puedes, vuelves…), so
// the voseo present without its accent ("tenes", "podes") is not a tú form.
// Not done for mover ("moves" is English) nor for -ar verbs ("contas" is
// Portuguese).
const STEM_CHANGING = new Set([
  'devolver', 'encender', 'entender', 'mantener', 'obtener', 'perder', 'poder', 'querer',
  'tener', 'volver',
]);
const CLITICS = [
  'lo', 'la', 'los', 'las', 'le', 'les', 'me', 'nos', 'te', 'melo', 'mela', 'selo', 'sela', 'telo',
];
// Generated forms that are also real words: a name, a vegetable, "yo creé",
// and English words that copy in English can contain ("validate").
const NOT_VOSEO = new Set([
  'tomás', 'tomate', 'creé', 'activate', 'explicate', 'habilitate', 'mandate', 'probate', 'validate',
]);

function voseoForms(): Set<string> {
  const forms = new Set<string>(['vos', 'acá', 'andá', 'andate', 'decí', 'vení']);
  const add = (verbs: string[], present: string, imperative: string | null, vowel: string) => {
    for (const verb of verbs) {
      const stem = verb.slice(0, -2);
      forms.add(stem + present);
      if (imperative) forms.add(stem + imperative);
      for (const clitic of CLITICS) forms.add(stem + vowel + clitic);
      if (STEM_CHANGING.has(verb)) forms.add(`${stem}es`); // "tenes", "podes"
    }
  };
  add(AR, 'ás', 'á', 'a');
  add(ER, 'és', 'é', 'e');
  add(IR, 'ís', null, 'i');
  // Every -ir voseo present has a different tú form (escribís / escribes).
  for (const verb of IR) forms.add(`${verb.slice(0, -2)}is`);
  for (const word of NOT_VOSEO) forms.delete(word);
  return forms;
}

const FORMS = voseoForms();
const WORD = /[\p{L}\p{M}]+/gu;
// "sos" is also the SOS incident type and button; only the verb is voseo:
// "sos" followed by another lowercase word ("si sos conductor").
const SOS_VERB = /(?<![\p{L}\p{N}_])sos\s+\p{Ll}/u;

function findVoseo(text: string): string[] {
  const hits = new Set<string>();
  for (const [word] of text.normalize('NFC').matchAll(WORD)) {
    const lower = word.toLowerCase();
    if (FORMS.has(lower)) hits.add(lower);
  }
  if (SOS_VERB.test(text)) hits.add('sos');
  return [...hits];
}

/** Copy in a TS/TSX source: string literals, template text and JSX text. Comments are not copy. */
function copyFragments(source: string, fileName: string): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      out.push(node.text);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

const BACKSLASH = '\\';
const blankOut = (text: string) => text.replace(/[^\n]/g, ' ');

/**
 * SQL source with its comments, quoted identifiers and the text of COMMENT ON
 * statements turned into spaces (same length, newlines kept); what is left is
 * code and string literals. The body of a function or a DO block (dollar-quoted
 * text right after AS or DO) is read as SQL too, so its comments are dropped
 * and its literals kept. Any other dollar-quoted text is a value (an e-mail
 * body, a cron command) and is kept whole, "--" and "<!--" included.
 */
function maskSql(source: string): string {
  const scan = (s: string): string => {
    let out = '';
    let statement = ''; // code since the last ";", to tell a body from a value and spot COMMENT ON … IS
    let i = 0;
    while (i < s.length) {
      if (s.startsWith('--', i)) {
        const newline = s.indexOf('\n', i);
        const stop = newline < 0 ? s.length : newline;
        out += blankOut(s.slice(i, stop));
        i = stop;
        continue;
      }
      if (s.startsWith('/*', i)) {
        // Postgres block comments nest.
        let depth = 0;
        let j = i;
        while (j < s.length) {
          if (s.startsWith('/*', j)) {
            depth++;
            j += 2;
          } else if (s.startsWith('*/', j)) {
            depth--;
            j += 2;
            if (depth === 0) break;
          } else {
            j++;
          }
        }
        out += blankOut(s.slice(i, j));
        i = j;
        continue;
      }

      let literal: string | null = null;
      let next = i;
      if (s[i] === "'") {
        // E'…' strings take backslash escapes; every string takes '' for a quote.
        const escapes = /[eE]/.test(s[i - 1] ?? '') && !/[\w$]/.test(s[i - 2] ?? '');
        let j = i + 1;
        while (j < s.length) {
          if (escapes && s[j] === BACKSLASH) {
            j += 2;
          } else if (s[j] === "'" && s[j + 1] === "'") {
            j += 2;
          } else if (s[j] === "'") {
            break;
          } else {
            j++;
          }
        }
        next = Math.min(j + 1, s.length);
        literal = s.slice(i, next);
      } else if (s[i] === '"') {
        // A quoted identifier is a name, not copy.
        let j = i + 1;
        while (j < s.length && !(s[j] === '"' && s[j + 1] !== '"')) j += s[j] === '"' ? 2 : 1;
        next = Math.min(j + 1, s.length);
        out += blankOut(s.slice(i, next));
        statement += '""';
        i = next;
        continue;
      } else if (s[i] === '$' && !/[\w$]/.test(s[i - 1] ?? '')) {
        const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64))?.[0];
        if (tag) {
          const close = s.indexOf(tag, i + tag.length);
          const body = s.slice(i + tag.length, close < 0 ? s.length : close);
          next = close < 0 ? s.length : close + tag.length;
          const isCode = /\b(?:AS|DO)\s*$/i.test(statement);
          literal = tag + (isCode ? scan(body) : body) + (close < 0 ? '' : tag);
        }
      }

      if (literal !== null) {
        const documentation = /\bCOMMENT\s+ON\b[^;]*\bIS\s*E?$/i.test(statement);
        out += documentation ? blankOut(literal) : literal;
        statement += "''";
        i = next;
        continue;
      }

      statement = s[i] === ';' ? '' : statement + s[i];
      out += s[i];
      i++;
    }
    return out;
  };
  return scan(source);
}

/**
 * The lines of a migration that can hold copy, with their line numbers. A
 * "tuteo-exempt" marker in a comment skips its own line, and the next line too
 * when the marker's line is only a comment: a patch migration that quotes the
 * old text it replaces marks it that way. The marker inside a string is text.
 */
function sqlCopyLines(source: string): { line: number; text: string }[] {
  const text = source.replace(/\r\n?/g, '\n');
  const original = text.split('\n');
  const masked = maskSql(text).split('\n');
  // maskSql blanked the marker only if it sits inside a comment.
  const marked = original.map((line, k) =>
    [...line.matchAll(/tuteo-exempt/g)].some((m) => (masked[k] ?? '')[m.index ?? 0] === ' '),
  );
  const commentOnly = (k: number) => (original[k] ?? '').trim() !== '' && (masked[k] ?? '').trim() === '';
  const exempt = (k: number) => marked[k] || (k > 0 && marked[k - 1] && commentOnly(k - 1));
  return masked
    .map((maskedLine, k) => ({ line: k + 1, text: maskedLine, skip: exempt(k) }))
    .filter(({ skip }) => !skip)
    .map(({ line, text: copy }) => ({ line, text: copy }));
}

function jsonStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(jsonStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(jsonStrings);
  return [];
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SKIP_DIRS = new Set(['node_modules', '.next', '.expo', '.turbo', 'android', 'ios', 'dist', 'build', 'coverage', '__tests__']);

function walk(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(path, keep);
    return keep(entry.name) ? [path] : [];
  });
}

const isSource = (name: string) => /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts');

// Migrations are checked from this number on. The older ones are frozen
// history: the voseo they still hold lives in function bodies that later
// migrations replaced (a prod scan on 2026-10-08 found no voseo copy in any
// live function, cron job or platform_config value), and 00638 quotes the two
// push texts it patched.
const SQL_SINCE = 639;
const MIGRATIONS = join(REPO, 'supabase/migrations');

function migrationsSince(since: number): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => {
      const match = /^(\d{5})_.*\.sql$/.exec(name);
      return match !== null && Number(match[1]) >= since;
    })
    .sort();
}

function offenders(): string[] {
  const out: string[] = [];
  const report = (file: string, texts: string[]) => {
    const where = relative(REPO, file).replace(/\\/g, '/');
    for (const text of texts) for (const form of findVoseo(text)) out.push(`${where}: ${form}`);
  };

  const localeDir = join(REPO, 'packages/i18n/src/locales/es');
  for (const file of walk(localeDir, (n) => n.endsWith('.json'))) {
    report(file, jsonStrings(JSON.parse(readFileSync(file, 'utf8'))));
  }

  const codeRoots = [
    ...['admin', 'client', 'driver', 'web'].flatMap((app) => [`apps/${app}/app`, `apps/${app}/src`]),
    ...readdirSync(join(REPO, 'packages')).map((pkg) => `packages/${pkg}/src`),
  ];
  for (const root of codeRoots) {
    let files: string[];
    try {
      files = walk(join(REPO, root), isSource);
    } catch {
      continue; // e.g. an app without an app/ directory
    }
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // Parsing ~800 files is the slow part. A file whose raw text (comments
      // included) has no voseo form and no \u escape cannot have one in its copy.
      if (findVoseo(source).length === 0 && !source.includes('\\u')) continue;
      report(file, copyFragments(source, file));
    }
  }

  const plainText = [
    ...['client', 'driver'].flatMap((app) =>
      walk(join(REPO, `apps/${app}/store-metadata/es`), (n) => /\.(md|txt)$/.test(n)),
    ),
    // GoTrue's e-mail templates and subjects. Prod reads them from the
    // Dashboard; these files are the copy pasted there and what local
    // `supabase start` sends.
    ...walk(join(REPO, 'supabase/templates'), (n) => n.endsWith('.html')),
    join(REPO, 'supabase/config.toml'),
  ];
  for (const file of plainText) report(file, [readFileSync(file, 'utf8')]);
  return [...new Set(out)].sort();
}

describe('voseo detector', () => {
  it('flags the voseo shapes of a verb in the list', () => {
    expect(findVoseo('Ya podés usarlo')).toEqual(['podés']);
    expect(findVoseo('Revisá tu correo')).toEqual(['revisá']);
    expect(findVoseo('Intentalo de nuevo')).toEqual(['intentalo']);
    expect(findVoseo('Seguinos en redes')).toEqual(['seguinos']);
    expect(findVoseo('Si tenes dudas')).toEqual(['tenes']);
    expect(findVoseo('¿Fuiste vos?')).toEqual(['vos']);
    expect(findVoseo('si sos conductor')).toEqual(['sos']);
  });

  it('accepts tuteo, the preterite and the SOS button', () => {
    for (const text of [
      'Ya puedes usarlo', 'Revisa tu correo', 'Inténtalo de nuevo', 'Síguenos en redes',
      'Si tienes dudas', 'Pedí por error', 'Le escribí', 'Lo encontré', '¿Qué estás buscando?',
      'Calle Tomás', 'SOS activado', 'sos', 'Escribe un correo válido',
    ]) {
      expect(findVoseo(text), text).toEqual([]);
    }
  });

  it('reads strings and JSX text but not comments', () => {
    const src = [
      '// Revisá: un comentario no es copy',
      "const a = t('k', { defaultValue: 'Probá con otro' });",
      'const b = <p>Ya podés cerrar esta página</p>;',
      'const c = `Volvé a intentarlo ${n}`;',
    ].join('\n');
    const found = copyFragments(src, 'snippet.tsx').flatMap(findVoseo);
    expect(found.sort()).toEqual(['podés', 'probá', 'volvé']);
  });
});

const sqlVoseo = (sql: string) => sqlCopyLines(sql).flatMap(({ text }) => findVoseo(text)).sort();

describe('SQL copy reader', () => {
  it('reads literals inside function bodies, but not comments', () => {
    const sql = [
      '-- Revisá: un comentario no es copy',
      '/* Probá el bloque /* anidado */ también */',
      'CREATE FUNCTION public.f() RETURNS trigger LANGUAGE plpgsql AS $function$',
      'BEGIN',
      '  -- Confirmá que este comentario tampoco cuenta',
      "  v_body := 'Tu recarga no pudo procesarse. Intentalo nuevamente.';",
      "  PERFORM notify(jsonb_build_object('body', 'Abrí la app y confirmá si lo ves.'));",
      "  RAISE EXCEPTION USING MESSAGE = 'Volvé a intentarlo', DETAIL = 'x';",
      'END;',
      '$function$;',
    ].join('\n');
    expect(sqlVoseo(sql)).toEqual(['confirmá', 'intentalo', 'volvé']);
  });

  it('keeps literal boundaries with doubled quotes, E-strings and dollar-quoted values', () => {
    const sql = [
      "SELECT 'it''s -- not a comment, revisá';",
      "SELECT E'line\\'s -- still a string, tocá';",
      "SELECT $m$Probá acá$m$, '-- dentro del literal: podés';",
      '-- después del literal: podés',
      // A dollar-quoted value is text, not SQL: "<!--" or "--" in it is not a comment.
      "PERFORM send(body := $html$<!-- header --><p>Confirmá tu correo</p>$html$);",
      'SELECT "vos" FROM t; -- a quoted identifier is a name, not copy',
    ].join('\n');
    expect(sqlVoseo(sql)).toEqual(['acá', 'confirmá', 'podés', 'probá', 'revisá', 'tocá']);
  });

  it('skips COMMENT ON text, which is documentation and not copy', () => {
    const sql = [
      "COMMENT ON FUNCTION public.f() IS 'Si lo tocás, revisá 00357 antes';",
      'COMMENT ON TABLE public.t IS',
      "  E'Mirá acá';",
      "COMMENT ON TABLE public.u IS'Fijate en 00599';",
      "DO $$ BEGIN COMMENT ON TABLE public.v IS 'Si lo cambiás, avisá'; END $$;",
      "SELECT 'Revisá tu correo';",
    ].join('\n');
    expect(sqlVoseo(sql)).toEqual(['revisá']);
  });

  it('honors tuteo-exempt only inside a comment, and below a comment-only line', () => {
    const sql = [
      "SELECT replace(b, 'Intentalo', 'Inténtalo'); -- tuteo-exempt: the text being replaced",
      "SELECT 'Llamá al 106';",
      '-- tuteo-exempt: the old push text, quoted to patch it',
      "SELECT 'Abrí la app y confirmá si lo ves.';",
      "SELECT 'tuteo-exempt', 'Revisá';",
      "SELECT 'Tocá';",
    ].join('\n');
    expect(sqlVoseo(sql)).toEqual(['llamá', 'revisá', 'tocá']);
  });

  it('keeps the length and the line numbers of the source', () => {
    const sql = "a := 'x'; -- comentario\n/* bloque\nde dos líneas */ b := 'Revisá';\n";
    expect(maskSql(sql)).toHaveLength(sql.length);
    expect(sqlCopyLines(sql).find(({ text }) => findVoseo(text).length)?.line).toBe(3);
  });

  it('flags the two push texts that 00638 had to fix, in the migrations that shipped them', () => {
    const read = (name: string) => readFileSync(join(REPO, 'supabase/migrations', name), 'utf8');
    expect(sqlVoseo(read('00357_notify_rider_on_gps_override_request.sql'))).toContain('confirmá');
    expect(sqlVoseo(read('00450_recharge_velocity_notif_currency_and_dead_grant.sql'))).toContain('intentalo');
  });
});

describe('Spanish copy uses tuteo', () => {
  it('no locale string, app/package string, store listing or e-mail template has voseo', () => {
    expect(offenders()).toEqual([]);
  }, 30_000);

  it('picks migrations by their number', () => {
    // Guards the filter below: if it broke, every new migration would be
    // skipped and the check would pass on an empty list.
    const fromFix = migrationsSince(638);
    expect(fromFix).toContain('00638_tuteo_server_push_texts.sql');
    expect(fromFix).not.toContain('00637_wallet_shortfall_pays_cash.sql');
    expect(migrationsSince(SQL_SINCE).every((name) => Number(name.slice(0, 5)) >= SQL_SINCE)).toBe(true);
  });

  it(`no migration from ${String(SQL_SINCE).padStart(5, '0')} on has voseo in its copy`, () => {
    const files = migrationsSince(SQL_SINCE);
    const out = files.flatMap((file) =>
      sqlCopyLines(readFileSync(join(MIGRATIONS, file), 'utf8')).flatMap(({ line, text }) =>
        findVoseo(text).map((form) => `supabase/migrations/${file}:${line}: ${form}`),
      ),
    );
    expect(out).toEqual([]);
  });
});
