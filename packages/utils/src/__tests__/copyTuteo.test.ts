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
//     templates (supabase/templates, the subjects in supabase/config.toml).
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

describe('Spanish copy uses tuteo', () => {
  it('no locale string, app/package string, store listing or e-mail template has voseo', () => {
    expect(offenders()).toEqual([]);
  }, 30_000);
});
