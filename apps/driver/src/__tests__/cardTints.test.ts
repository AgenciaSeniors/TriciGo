// ============================================================
// Guardrail: a color passed to <Card> through className must be the
// color that renders.
//
// NativeWind does not apply conflicting classes in the order they are
// written. react-native-css-interop sorts the rules that match by
// specificity and then by their order in the compiled stylesheet, which
// Tailwind sorts alphabetically within a utility. Card puts its own
// background and border classes in the same className (bg-white for
// theme="light", bg-neutral-50 / dark:bg-neutral-800 for "filled", …), so
// `<Card theme="light" className="bg-orange-50">` renders white: .bg-white
// comes after .bg-orange-50. With forceDark, Card sets the background as an
// inline style, which beats every class. Nothing fails, the tint just never
// shows, so this is checked here instead of by eye.
//
// For every <Card> in the driver app this compiles Card's classes and the
// caller's with the app's Tailwind config through NativeWind's own compiler,
// and reports each background or border color from className that loses, in
// light or dark mode, or that the theme does not define. A card that needs
// its own color is a TintedCard (src/components/TintedCard.tsx), which has no
// color to lose to and is only checked for colors the theme does not define.
// ============================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import postcss from 'postcss';
import tailwindcss, { type Config } from 'tailwindcss';
import { cssToReactNativeRuntime } from 'react-native-css-interop/dist/css-to-rn';

const DRIVER = fileURLToPath(new URL('../..', import.meta.url));
const CARD_SOURCE = path.resolve(DRIVER, '../../packages/ui/src/Card.tsx');
// tailwind.config.js is CommonJS, as Metro and NativeWind load it.
const tailwindConfig = createRequire(import.meta.url)('../../tailwind.config.js') as Config;

type Prop = 'bg' | 'border';
type Mode = 'light' | 'dark';

interface CardUsage {
  where: string;
  base: string[];
  /** Classes the caller passes; for a dynamic className, every literal in it. */
  extra: string[];
  /** Colors Card sets as an inline style (forceDark / theme="dark"). */
  inline: Set<Prop>;
}

// Card's own classes, read from the component so a change there is picked up.
function readCard() {
  const src = fs.readFileSync(CARD_SOURCE, 'utf8');
  const variants: Record<string, string> = {};
  for (const m of src.matchAll(/^\s+(elevated|outlined|filled|surface): '([^']+)'/gm)) variants[m[1]!] = m[2]!;
  const light = src.match(/const lightThemeClass = '([^']+)'/)?.[1];
  const forceDark: Record<string, string> = {};
  const block = src.match(/const forceDarkStyles[^=]*= \{([\s\S]*?)\n\};/)?.[1] ?? '';
  for (const m of block.matchAll(/^\s+(\w+): \{([^}]*)\}/gm)) forceDark[m[1]!] = m[2]!;
  if (Object.keys(variants).length !== 4 || !light || Object.keys(forceDark).length !== 4) {
    throw new Error(`Could not read Card's classes from ${CARD_SOURCE}; update this test to match it.`);
  }
  return { variants, light, forceDark };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

function stringsIn(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.flatMap((span) => [...stringsIn(span.expression), span.literal.text])];
  }
  const out: string[] = [];
  node.forEachChild((child) => { out.push(...stringsIn(child)); });
  return out;
}

function cardUsages(): CardUsage[] {
  const card = readCard();
  const usages: CardUsage[] = [];
  for (const file of [...walk(path.join(DRIVER, 'app')), ...walk(path.join(DRIVER, 'src'))]) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      const tag = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node : null;
      const name = tag?.tagName.getText(sf);
      if (tag && (name === 'Card' || name === 'TintedCard')) {
        const attrs = new Map<string, ts.JsxAttribute>();
        for (const a of tag.attributes.properties) if (ts.isJsxAttribute(a)) attrs.set(a.name.getText(sf), a);
        const literal = (attr: string) => {
          const init = attrs.get(attr)?.initializer;
          return init && ts.isStringLiteral(init) ? init.text : undefined;
        };
        const className = attrs.get('className')?.initializer;
        const { line } = sf.getLineAndCharacterOfPosition(tag.getStart(sf));
        const usage: CardUsage = {
          where: `${path.relative(DRIVER, file)}:${line + 1}`,
          base: [],
          extra: className ? stringsIn(className).join(' ').split(/\s+/).filter(Boolean) : [],
          inline: new Set<Prop>(),
        };
        // A TintedCard has no colors of its own: it is only checked for colors the theme lacks.
        if (name === 'Card') {
          const forceDarkInit = attrs.get('forceDark')?.initializer;
          const forceDark = attrs.has('forceDark') && forceDarkInit?.getText(sf) !== '{false}';
          const theme = literal('theme') ?? 'auto';
          const variant = literal('variant') ?? 'elevated';
          const isLight = theme === 'light';
          const inlineStyle = !isLight && (forceDark || theme === 'dark') ? card.forceDark[variant] ?? '' : '';
          usage.base = (isLight ? `${card.light} rounded-2xl` : card.variants[variant] ?? '').split(/\s+/).filter(Boolean);
          if (/backgroundColor/.test(inlineStyle)) usage.inline.add('bg');
          if (/borderColor/.test(inlineStyle)) usage.inline.add('border');
        }
        usages.push(usage);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return usages;
}

interface ColorRule {
  props: Set<Prop>;
  dark: boolean;
  /** NativeWind's tie-break after specificity: [class count, stylesheet order]. */
  rank: [number, number];
}

async function compile(classes: string[]) {
  const config = { ...tailwindConfig, content: [{ raw: classes.join(' '), extension: 'html' }] };
  const { css, root } = await postcss([tailwindcss(config)]).process('@tailwind utilities;', { from: undefined });
  // The class each rule belongs to: `.dark\:bg-error\/20:is(.dark *)` → dark:bg-error/20.
  const generated = new Set<string>();
  root.walkRules((rule) => {
    const name = rule.selector.match(/^\.((?:\\.|[\w-])+)/)?.[1];
    if (name) generated.add(name.replace(/\\(.)/g, '$1'));
  });
  const rules = cssToReactNativeRuntime(css, {}).rules ?? {};
  const colorRule = (c: string): ColorRule | null => {
    const rule = rules[c]?.n?.[0];
    if (!rule) return null;
    const declarations = JSON.stringify(rule.d ?? []);
    const props = new Set<Prop>();
    if (/"backgroundColor"/.test(declarations)) props.add('bg');
    if (/"border(Top|Right|Bottom|Left)?Color"/.test(declarations)) props.add('border');
    return props.size ? { props, dark: c.startsWith('dark:'), rank: [rule.s[1] ?? 0, rule.s[0] ?? 0] } : null;
  };
  return { generated, colorRule };
}

const outranks = (a: ColorRule, b: ColorRule) => (a.rank[0] !== b.rank[0] ? a.rank[0] > b.rank[0] : a.rank[1] > b.rank[1]);
// bg-/border- classes that set a color, as opposed to width, style, position…
const COLOR_CLASS =
  /^(dark:)?(bg|border)-(?!opacity|gradient|none|cover|contain|center|fixed|local|scroll|repeat|no-repeat|clip|origin|blend|top|bottom|left|right|solid|dashed|dotted|double|hidden|collapse|separate|spacing|[xytrblse]-|\d)/;

describe('colors passed to <Card> through className', () => {
  it('are the colors that render', async () => {
    const usages = cardUsages();
    expect(usages.length).toBeGreaterThan(50); // the parser found the cards

    const { generated, colorRule } = await compile([...new Set(usages.flatMap((u) => [...u.base, ...u.extra]))]);
    const problems: string[] = [];
    for (const u of usages) {
      for (const c of u.extra) {
        if (COLOR_CLASS.test(c) && !generated.has(c)) problems.push(`${u.where}: ${c} is not defined by the theme`);
        const rule = colorRule(c);
        if (!rule) continue;
        for (const prop of rule.props) {
          for (const mode of ['light', 'dark'] as Mode[]) {
            if (rule.dark && mode === 'light') continue;
            // A light-only color yields to the caller's own dark: color.
            const callerDark = u.extra.some((x) => x.startsWith('dark:') && colorRule(x)?.props.has(prop));
            if (!rule.dark && mode === 'dark' && callerDark) continue;
            if (u.inline.has(prop)) {
              problems.push(`${u.where}: ${c} (${mode}) loses to Card's inline forceDark style`);
              continue;
            }
            const rival = u.base
              .map((b) => ({ b, r: colorRule(b) }))
              .find(({ r }) => r && r.props.has(prop) && (mode === 'dark' || !r.dark) && outranks(r, rule));
            if (rival) problems.push(`${u.where}: ${c} (${mode}) loses to Card's ${rival.b}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
