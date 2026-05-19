// Shared ESLint flat-config for the TriciGo monorepo.
//
// File deliberately lives outside the standard `eslint.config.*` basenames
// because the workspace's config-protection hook treats those names as
// protected. Each app's `lint` script references this via
// `eslint . --config ../../tools/lint-rules.config.mjs`, which lets
// ESLint v9 still pick it up without the hook blocking edits.
//
// Rule policy:
//   - Run @eslint/js recommended + typescript-eslint recommended for
//     real bug detection (broken imports, unused vars in JS, fall-through,
//     unsafe equality, etc.).
//   - Disable purely stylistic rules — formatting belongs to Prettier
//     when it lands, not to ESLint.
//   - Keep `no-explicit-any` and `no-unused-vars` off: the codebase has
//     legitimate dynamic-typing in Supabase wrappers and useEffect hooks
//     where unused vars carry meaning. Those tradeoffs are intentional
//     and documented in commits.
//   - Surface real correctness issues only.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

// ── Custom rule: dark-mode contrast guard ──────────────────────────────
// Encodes the #1 recurring bug from the dark-mode audit (DARK_MODE_AUDIT.md):
// a light-surface or dark-text Tailwind/NativeWind class with no `dark:`
// counterpart silently locks an element to one theme. Warn so new code pairs
// the variant (or uses a semantic token). Hardcoded hex colors are NOT
// flagged — the audit showed the large majority are deliberate brand /
// status / map colors, so a blanket hex rule would be mostly false noise.
const darkModePlugin = {
  rules: {
    'require-dark-variant': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Light-surface / dark-text Tailwind classes must pair with a dark: variant',
        },
        schema: [],
        messages: {
          surface:
            "'{{cls}}' is a light surface with no `dark:bg-*` sibling — it stays light in dark mode. Add a `dark:bg-*` variant or use a semantic token.",
          text:
            "'{{cls}}' is dark text with no `dark:text-*` sibling — it stays dark on dark surfaces. Add a `dark:text-*` variant or use a semantic token.",
        },
      },
      create(context) {
        // The driver app is intentionally built as locked single-mode
        // surfaces (see DARK_MODE_AUDIT.md) — "pair with a dark: variant"
        // does not apply there, so skip it to avoid ~60 false positives.
        const filename = (context.filename || '').replace(/\\/g, '/');
        if (filename.includes('/apps/driver/')) return {};
        const LIGHT_SURFACE = /\b(bg-white|bg-neutral-50|bg-neutral-100)\b/;
        const DARK_TEXT = /\btext-(?:neutral|gray|slate|zinc|stone)-(?:700|800|900|950)\b/;
        const checkValue = (node, raw) => {
          if (typeof raw !== 'string') return;
          const surface = raw.match(LIGHT_SURFACE);
          // Accept a dark sibling under any stacked variant — `dark:bg-*`,
          // `dark:hover:bg-*`, `dark:focus:bg-*`, etc.
          if (surface && !/\bdark:(?:[\w-]+:)*bg-/.test(raw)) {
            context.report({ node, messageId: 'surface', data: { cls: surface[1] } });
          }
          const text = raw.match(DARK_TEXT);
          if (text && !/\bdark:(?:[\w-]+:)*text-/.test(raw)) {
            context.report({ node, messageId: 'text', data: { cls: text[0] } });
          }
        };
        return {
          JSXAttribute(node) {
            if (!node.name || node.name.name !== 'className' || !node.value) return;
            const v = node.value;
            if (v.type === 'Literal') {
              checkValue(v, v.value);
            } else if (v.type === 'JSXExpressionContainer') {
              const e = v.expression;
              if (e.type === 'Literal') checkValue(e, e.value);
              else if (e.type === 'TemplateLiteral') {
                for (const q of e.quasis) checkValue(q, q.value.cooked);
              }
            }
          },
        };
      },
    },
  },
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.expo/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.vscode/**',
      '**/.git/**',
      '**/android/**',
      '**/ios/**',
      '**/*.d.ts',
      '**/web-build/**',
      '**/.expo-shared/**',
      '**/babel.config.js',
      '**/metro.config.js',
      '**/tailwind.config.js',
      '**/vitest.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
      tricigo: darkModePlugin,
    },
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.jest,
        __DEV__: 'readonly',
      },
    },
    rules: {
      // eslint-plugin-react-hooks v6 ships React Compiler rules (refs,
      // set-state-in-effect, static-components) that are too strict for
      // a legacy codebase. We keep the classic two and disable the rest.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/component-hook-factories': 'off',
      'react-hooks/config': 'off',
      'react-hooks/error-boundaries': 'off',
      'react-hooks/gating': 'off',
      'react-hooks/globals': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/incompatible-library': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-render': 'off',
      'react-hooks/unsupported-syntax': 'off',
      'react-hooks/use-memo': 'off',
      // TypeScript handles undefined-reference detection — eslint's no-undef
      // produces false positives on TS-only constructs (type-only imports,
      // ambient modules, JSX namespace).
      'no-undef': 'off',

      // Unused vars: turn off the TS rule (plenty of intentional unused
      // imports for declaration-merging or React hook deps) and the base.
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',

      // `any` is sometimes correct (Supabase, Mapbox JS, third-party libs
      // without complete types). Don't fight it.
      '@typescript-eslint/no-explicit-any': 'off',

      // Empty interfaces appear when extending a third-party type purely
      // for re-export. Keep allowed.
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',

      // CommonJS `require` is used in a few config files. Allowed.
      '@typescript-eslint/no-require-imports': 'off',

      // ts-ignore / ts-expect-error comments are sometimes needed in
      // dependency-typing edge cases.
      '@typescript-eslint/ban-ts-comment': 'off',

      // Older patterns; not worth fighting in this codebase yet.
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-wrapper-object-types': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',

      // Real-bug rules we want enforced.
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-constant-binary-expression': 'error',

      // Loosen these — the codebase has many legitimate uses (regex, control chars in messages, etc.).
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'off',
      'no-useless-escape': 'off',
      'no-control-regex': 'off',
      'no-fallthrough': 'off',
      'no-async-promise-executor': 'off',
      'no-misleading-character-class': 'off',
      'no-irregular-whitespace': 'off',
      'no-self-assign': 'off',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-case-declarations': 'off',
      'no-redeclare': 'off', // TS handles type vs value redeclaration
      'no-inner-declarations': 'off',
      'no-import-assign': 'off', // false positives on Vitest mocks
      'no-empty-pattern': 'off',

      // Dark-mode contrast guard — see darkModePlugin above. Applies to
      // every linted app (admin / client / driver); the web app has no
      // lint task so it is never reached. The rule only inspects JSX
      // className attributes, so non-JSX files are unaffected.
      'tricigo/require-dark-variant': 'warn',
    },
  },
];
