// ============================================================
// Guardrail: Spanish copy keeps its written accents.
//
// On 2026-10-07 a sweep (#1114) found ~240 strings without their accents:
// whole pages and locale blocks written as "24 horas habiles", "Inicia
// sesion", "Sientate", "recibiras una notificacion cuando este aprobada".
// Nothing checked it, so new copy copied the style around it. This test
// scans the same copy as copyTuteo.test.ts and fails on a word that is
// never correct without its accent:
//   - a curated list of words (aqui, despues, telefono, codigo, resenas…),
//   - any singular "-cion"/"-xion", and "-sion" inside Spanish text (so the
//     English "version" and "session" pass),
//   - generated verb forms: futures and conditionals ("recibiras", "podria"),
//     imperfects ("tenia"), preterites ("recogio") and tú imperatives with a
//     pronoun ("intentalo", "escribenos", "sientate"),
//   - a question word right after "¿" ("¿Que pasa", "¿Por que").
// Words that are also correct without the accent are left out on purpose,
// because context decides: esta/está, el/él, tu/tú, si/sí, mas/más, aun/aún,
// solo, este/esté, que/qué outside "¿", llego/llegó, publico, numero is kept
// (no copy says "yo numero"), the -ar future/subjunctive pair (revisara),
// "¿Cuando…" (also a conditional question: "¿Cuando termines, me avisas?").
// Identifiers are not copy: tokens with _ - . / @ or digits, and code string
// literals that are a single lowercase word ('mensajeria' is a service type).
// The en/pt values of { es, en, pt } maps and the accent-stripped search data
// in packages/utils (geo, addressSearch, cuba-geo) are skipped too.
// When a real word slips through, add it to WORDS below.
// ============================================================

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WORDS = `
aqui alli ahi asi aca alla tambien despues ademas todavia atras detras jamas segun algun ningun comun quizas
facil faciles dificil dificiles util utiles movil moviles exito exitos linea lineas
telefono telefonos codigo codigos numero numeros vehiculo vehiculos pagina paginas metodo metodos
minimo minima minimos minimas maximo maxima maximos maximas ultimo ultima ultimos ultimas
proximo proxima proximos proximas rapido rapida rapidos rapidas rapidamente unico unica unicos unicas unicamente
basico basica basicos basicas electronico electronica electronicos electronicas automatico automatica
automaticos automaticas automaticamente economico economica economicos economicas tecnico tecnica tecnicos tecnicas
politica politicas terminos boton razon corazon guia guias dia dias pais paises busqueda busquedas credito creditos
kilometro kilometros categoria categorias mensajeria tecnologia gastronomia logistica logisticos geografia
cafeteria garantia garantias compania companias energia policia economia bateria vacio vacia vacios vacias
digito digitos habil habiles estandar fragil sesion comision mision
contrasena contrasenas espanol senal senales resena resenas pequeno pequena pequenos pequenas manana dueno duenos
diseno companero pestana acompana acompanas acompanan acompanando acompanante acompanantes sera seras seran
`.split(/\s+/).filter(Boolean);

const AR = [
  'aceptar', 'activar', 'actualizar', 'agregar', 'ajustar', 'anotar', 'asegurar', 'avisar', 'borrar', 'buscar',
  'calificar', 'cancelar', 'cargar', 'chequear', 'completar', 'confirmar', 'consultar', 'contactar', 'copiar',
  'dejar', 'descargar', 'editar', 'enviar', 'esperar', 'explicar', 'fijar', 'guardar', 'habilitar', 'ingresar',
  'intentar', 'invitar', 'llamar', 'llenar', 'llevar', 'mandar', 'marcar', 'mirar', 'olvidar', 'pagar', 'pasar',
  'presionar', 'programar', 'quedar', 'recargar', 'regalar', 'registrar', 'reintentar', 'reportar', 'reservar',
  'retirar', 'revisar', 'solicitar', 'tocar', 'tomar', 'ubicar', 'usar', 'validar', 'verificar',
];
const ER = [
  'aparecer', 'aprender', 'conocer', 'correr', 'creer', 'deber', 'depender', 'devolver', 'encender', 'entender',
  'establecer', 'leer', 'mover', 'ofrecer', 'perder', 'prometer', 'proteger', 'recoger', 'reconocer', 'responder',
  'vender', 'volver',
];
const IR = [
  'abrir', 'añadir', 'compartir', 'cumplir', 'decidir', 'describir', 'escribir', 'existir', 'imprimir', 'permitir',
  'recibir', 'subir', 'vivir',
];
// Irregular future/conditional stems (podrá, tendría, dirá…).
const IRREGULAR_STEMS = ['podr', 'tendr', 'habr', 'sabr', 'saldr', 'vendr', 'pondr', 'querr', 'dir', 'har', 'valdr', 'mantendr', 'obtendr'];
// tú imperatives that are not stem + a/e: they change the stem (prueba, cierra, pide…).
const IRREGULAR_IMPERATIVES = [
  'prueba', 'cuenta', 'recuerda', 'cierra', 'encuentra', 'sienta', 'muestra', 'vuelve', 'devuelve', 'mueve',
  'pide', 'sigue', 'elige', 'consigue', 'enciende', 'entiende', 'pierde', 'escoge',
];
// No bare "se": stem + "ase" is the imperfect subjunctive ("usase", "pagase").
const CLITICS = ['lo', 'la', 'los', 'las', 'le', 'les', 'me', 'nos', 'te', 'melo', 'mela', 'selo', 'sela', 'telo'];
const IRREGULAR_PRETERITES = ['pidio', 'siguio', 'eligio', 'consiguio', 'sirvio', 'leyo', 'creyo'];
// Generated forms that are also real words: a vegetable, "comete" (he commits)
// and English words that copy in English can contain.
const VALID_WITHOUT_ACCENT = new Set([
  'tomate', 'comete', 'activate', 'explicate', 'habilitate', 'mandate', 'validate', 'sumaria', 'cambiaria',
]);

function bannedForms(): Set<string> {
  const forms = new Set<string>(WORDS);
  for (const verb of [...ER, ...IR]) {
    const stem = verb.slice(0, -2);
    for (const end of ['a', 'as', 'an', 'e', 'ia', 'ias', 'ian', 'iamos']) forms.add(verb + end); // recibirá(s/n), recibiré, recibiría…
    for (const end of ['ia', 'ias', 'ian']) forms.add(stem + end); // recibía, tenía
    forms.add(`${stem}io`); // recibió, recogió
    for (const clitic of CLITICS) forms.add(`${stem}e${clitic}`); // escríbenos, recógelo
  }
  for (const verb of AR) {
    const stem = verb.slice(0, -2);
    for (const end of ['ia', 'ias', 'ian', 'iamos']) forms.add(verb + end); // confirmaría
    for (const clitic of CLITICS) forms.add(`${stem}a${clitic}`); // inténtalo, regístrate
  }
  for (const stem of IRREGULAR_STEMS) {
    for (const end of ['a', 'as', 'an', 'ia', 'ias', 'ian', 'iamos']) forms.add(stem + end); // podrá, tendría
  }
  // Not hacer: "hacia" is also the preposition.
  for (const verb of ['tener', 'haber', 'poder', 'querer', 'decir', 'salir', 'seguir']) {
    for (const end of ['ia', 'ias', 'ian']) forms.add(verb.slice(0, -2) + end); // tenía, podía, decía
  }
  for (const imperative of IRREGULAR_IMPERATIVES) for (const clitic of CLITICS) forms.add(imperative + clitic);
  for (const form of IRREGULAR_PRETERITES) forms.add(form);
  for (const form of VALID_WITHOUT_ACCENT) forms.delete(form);
  return forms;
}

const BANNED = bannedForms();
const NOT_SPANISH_ION = new Set(['suspicion', 'coercion', 'complexion']);
// Spanish-only function words: a fragment with one of them is Spanish text.
const SPANISH = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'en', 'con', 'para', 'por', 'una', 'un', 'que', 'tu', 'tus', 'su', 'sus', 'al', 'es', 'se', 'sin', 'y']);
const TOKEN = /[\p{L}\p{M}\p{N}_@][\p{L}\p{M}\p{N}_\-./@]*/gu;
const QUESTION = /¿\s*(por\s+que|que|como|donde|quien|quienes|cual|cuales|cuanto|cuanta|cuantos|cuantas)(?![\p{L}\p{M}])/giu;

function findMissingAccents(text: string): string[] {
  // Interpolation placeholders ({{version}}, {max}) are code, not copy.
  const copy = text.normalize('NFC').replace(/\{\{[^}]*\}\}|\{[^}]*\}/g, ' ');
  const tokens = [...copy.matchAll(TOKEN)].map(([t]) => t.replace(/[.\-/]+$/, '').toLowerCase());
  const spanish = tokens.some((t) => SPANISH.has(t));
  const hits = new Set<string>();
  for (const [, word] of copy.matchAll(QUESTION)) hits.add(`¿${word.toLowerCase().replace(/\s+/g, ' ')}`);
  for (const token of tokens) {
    if (!/^[\p{L}]+$/u.test(token) || /[áéíóú]/.test(token)) continue; // identifier, or already accented
    if (BANNED.has(token)) hits.add(token);
    else if (/[cx]ion$/.test(token) && token.length > 4 && !NOT_SPANISH_ION.has(token)) hits.add(token);
    else if (spanish && /sion$/.test(token) && token.length > 4) hits.add(token);
  }
  return [...hits];
}

/** Copy in a TS/TSX source: string literals, template text and JSX text. Comments are not copy. */
function copyFragments(source: string, fileName: string): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    // { es, en, pt } label maps: the en and pt values are not Spanish.
    if (ts.isPropertyAssignment(node) && ['en', 'pt'].includes(node.name.getText(sf).replace(/['"]/g, ''))) return;
    if (ts.isJsxText(node)) out.push(node.text);
    else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      // A code string with no spaces that is a lowercase word, a route or a URL
      // ('mensajeria', '/mensajeria', '/(tabs)?service=mensajeria') is not copy.
      const text = node.text.trim();
      if (!(!/\s/.test(text) && (/^\p{Ll}/u.test(text) || /[/?=&:#_.]/.test(text)))) out.push(node.text);
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
// Accent-stripped on purpose: search keys and aliases matched against normalized input.
const SEARCH_DATA = new Set(['packages/utils/src/geo.ts', 'packages/utils/src/addressSearch.ts', 'packages/utils/src/cuba-geo.ts']);

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
    for (const text of texts) for (const word of findMissingAccents(text)) out.push(`${where}: ${word}`);
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
      if (SEARCH_DATA.has(relative(REPO, file).replace(/\\/g, '/'))) continue;
      report(file, copyFragments(readFileSync(file, 'utf8'), file));
    }
  }

  const plainText = [
    ...['client', 'driver'].flatMap((app) =>
      walk(join(REPO, `apps/${app}/store-metadata/es`), (n) => /\.(md|txt)$/.test(n)),
    ),
    ...walk(join(REPO, 'supabase/templates'), (n) => n.endsWith('.html')),
    join(REPO, 'supabase/config.toml'),
  ];
  // Line by line, so an English comment never counts as Spanish text.
  for (const file of plainText) report(file, readFileSync(file, 'utf8').split('\n'));
  return [...new Set(out)].sort();
}

describe('missing-accent detector', () => {
  it('flags words that are never correct without their accent', () => {
    expect(findMissingAccents('Inicia sesion para continuar')).toEqual(['sesion']);
    expect(findMissingAccents('Verifica el telefono')).toEqual(['telefono']);
    expect(findMissingAccents('Disponible despues del viaje')).toEqual(['despues']);
    expect(findMissingAccents('Te respondemos en 24 horas habiles')).toEqual(['habiles']);
    expect(findMissingAccents('Abuso en resenas')).toEqual(['resenas']);
    expect(findMissingAccents('Acompanando')).toEqual(['acompanando']);
  });

  it('flags any singular -cion, and -sion inside Spanish text', () => {
    expect(findMissingAccents('Esperando confirmacion...')).toEqual(['confirmacion']);
    expect(findMissingAccents('Sin conexion a internet')).toEqual(['conexion']);
    expect(findMissingAccents('Las notificaciones de tu viaje')).toEqual([]);
    expect(findMissingAccents('Update to the latest version')).toEqual([]);
  });

  it('flags future, conditional and preterite forms that need the accent', () => {
    expect(findMissingAccents('Un administrador la revisara y recibiras una respuesta')).toEqual(['recibiras']);
    expect(findMissingAccents('Tus comisiones apareceran aqui')).toEqual(['apareceran', 'aqui']);
    expect(findMissingAccents('Podria tardar unos minutos')).toEqual(['podria']);
    expect(findMissingAccents('El conductor recogio tu paquete')).toEqual(['recogio']);
  });

  it('flags tú imperatives with a pronoun', () => {
    expect(findMissingAccents('Sientate en el asiento trasero')).toEqual(['sientate']);
    expect(findMissingAccents('Escribenos a soporte')).toEqual(['escribenos']);
    expect(findMissingAccents('Registrate en la app')).toEqual(['registrate']);
  });

  it('flags question words right after ¿', () => {
    expect(findMissingAccents('¿Que pasa con el saldo?')).toEqual(['¿que']);
    expect(findMissingAccents('¿Por que no llega?')).toEqual(['¿por que']);
    expect(findMissingAccents('¿Cuando termines, me avisas?')).toEqual([]);
  });

  it('accepts correct copy and words that are valid without an accent', () => {
    for (const text of [
      'Inicia sesión para continuar', 'Tu paquete está en camino', 'Esta parada', 'Si tu empresa está registrada',
      'Aún no hay viajes', 'aun así', 'Cargar más', 'Solo pagas lo que usas', 'Llego tarde', 'Te publico el aviso',
      'Pedí por error', 'Tu crédito', 'el tomate', 'Ve a la página', 'Hazlo ya', 'Rio de Janeiro',
      'Activate your account', 'Tasa de cambio', 'Transporte bajo demanda', 'Paso 1 de 3', 'Versión {{version}}',
    ]) {
      expect(findMissingAccents(text), text).toEqual([]);
    }
  });

  it('skips identifiers, en/pt values and comments', () => {
    const src = [
      '// Inicia sesion: un comentario no es copy',
      "const a = serviceType === 'mensajeria';",
      "const r = [<a href=\"/mensajeria\">Mensajería</a>, '/(tabs)?service=mensajeria'];",
      "const b = t('web.login_required', { defaultValue: 'Inicia sesion' });",
      "const c = { es: 'Paquete pequeño', en: 'Small package', pt: 'Pacote pequeno' };",
      'const d = <p>Configuracion</p>;',
    ].join('\n');
    expect(copyFragments(src, 'snippet.tsx').flatMap(findMissingAccents).sort()).toEqual(['configuracion', 'sesion']);
  });
});

describe('Spanish copy keeps its accents', () => {
  it('no locale string, app/package string, store listing or e-mail template drops an accent', () => {
    expect(offenders()).toEqual([]);
  }, 30_000);
});
