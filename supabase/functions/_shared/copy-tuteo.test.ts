import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// TriciGo copy is tuteo (tú), never voseo. The 2026-07-31 sweep covered the apps
// and packages but not supabase/functions, so the e-mails, SMS alerts and payment
// errors kept "podés", "Escribinos", "¿No fuiste vos?" until 2026-10-07.
//
// Only string and template-literal text is scanned (comments in Spanish stay as
// they are). The list holds the forms that were removed. Two are left out on
// purpose: "Abrí" and "Elegí" are also the first-person preterite ("yo abrí",
// "yo elegí"), which is valid copy, so banning them would flag correct text.
const VOSEO_FORMS = [
  'Aceptá', 'Activá', 'Acá', 'Calificá', 'Cargá', 'Cerrá', 'Confirmá', 'Conservá',
  'contactá', 'contactanos', 'creés', 'encontrás', 'Entrá', 'Escribinos', 'Guardá',
  'ignorá', 'Intentalo', 'movés', 'Necesitás', 'pagá', 'podés', 'probá', 'querés',
  'recargá', 'Recibís', 'reconocés', 'reintentá', 'Respondé', 'Restablecé', 'Revisá',
  'seguilo', 'Tocá', 'Tomá', 'Usá', 'verificá', 'Volvé', 'vos',
];

// Unicode-aware word boundaries: \b is ASCII-only in JS, so /\bpodés\b/ never
// matches the trailing "s" after "é" the way it looks like it should.
const wordPattern = (w: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${w}(?![\\p{L}\\p{N}_])`, 'iu');
const BANNED = VOSEO_FORMS.map((w) => ({ form: w, re: wordPattern(w) }));
// "sos" is also the SOS incident type ('sos' in send-push). Only the verb is
// banned: "sos" followed by another lowercase word ("sos contacto de confianza").
BANNED.push({ form: 'sos <palabra>', re: /(?<![\p{L}\p{N}_])sos\s+\p{Ll}/u });

function copyFragments(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push(node.text);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

function findVoseo(source: string, fileName = 'snippet.ts'): string[] {
  const hits: string[] = [];
  for (const text of copyFragments(source, fileName)) {
    for (const { form, re } of BANNED) {
      if (re.test(text)) hits.push(form);
    }
  }
  return hits;
}

const FUNCTIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('Edge Function copy uses tuteo', () => {
  it('flags voseo in strings and template literals, not in comments', () => {
    const src = [
      '// Confirmá que el comentario no cuenta',
      "const a = 'Escribinos a soporte@tricigo.com';",
      'const b = `Recibís este aviso porque sos contacto de confianza`;',
      "const c = 'sos';",
      "const d = 'Escríbenos a soporte@tricigo.com';",
    ].join('\n');

    expect(findVoseo(src).sort()).toEqual(['Escribinos', 'Recibís', 'sos <palabra>'].sort());
  });

  it('no Edge Function source has voseo in its copy', () => {
    const files = sourceFiles(FUNCTIONS_DIR);
    expect(files.length).toBeGreaterThan(50);

    const offenders = files.flatMap((file) =>
      findVoseo(readFileSync(file, 'utf8'), file).map(
        (form) => `${relative(FUNCTIONS_DIR, file).replace(/\\/g, '/')}: ${form}`,
      ),
    );

    expect(offenders).toEqual([]);
  });
});
