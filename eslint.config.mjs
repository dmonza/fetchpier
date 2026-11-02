import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript rules for all TS files
  ...tseslint.configs.recommended,

  // React Hooks rules (renderer only)
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules
  },

  // Project-wide rule overrides
  {
    files: [
      'src/**/*.{ts,tsx}',
      'packages/fetchpier-core/**/*.ts',
      'packages/fetchpier-cli/**/*.ts'
    ],
    rules: {
      // Allow underscore-prefixed unused vars (common in callbacks)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      // Allow explicit `any` in IPC boundaries where types come from outside
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  },

  // Network egress invariant (REQ-0061). The renderer and preload must never
  // originate network traffic — every byte of egress goes through `@fetchpier/core`
  // (undici) or the main-process update check. This is the lint-time half of the
  // three-layer enforcement (lint + `npm run audit:network` bundle scan + the
  // `network-egress.spec.ts` runtime e2e). Core and main are intentionally NOT
  // covered: they are the authorized egress layers.
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'src/preload/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Network egress is forbidden in the renderer/preload (network egress invariant). Route requests through window.api → IPC → @fetchpier/core.'
        },
        {
          name: 'XMLHttpRequest',
          message:
            'Network egress is forbidden in the renderer/preload (network egress invariant). Use window.api.'
        },
        {
          name: 'WebSocket',
          message:
            'Network egress is forbidden in the renderer/preload (network egress invariant). Use window.api.'
        },
        {
          name: 'EventSource',
          message:
            'Network egress is forbidden in the renderer/preload (network egress invariant). Use window.api.'
        },
        {
          name: 'Image',
          message:
            'Constructing Image() can trigger a remote fetch (network egress invariant). Render local/data-URI sources only.'
        }
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[object.name=/^(window|globalThis|self)$/][property.name=/^(fetch|XMLHttpRequest|WebSocket|EventSource|Image)$/]',
          message:
            'Network egress is forbidden in the renderer/preload (network egress invariant). Route requests through window.api → IPC → @fetchpier/core.'
        },
        {
          selector:
            "MemberExpression[object.name='navigator'][property.name=/^(sendBeacon|connection)$/]",
          message:
            'navigator.sendBeacon / navigator.connection are network primitives forbidden in the renderer/preload (network egress invariant).'
        },
        {
          selector: "NewExpression[callee.name='Image']",
          message:
            'new Image() can trigger a remote fetch (network egress invariant). Render local/data-URI sources only.'
        }
      ]
    }
  },

  // Boundary guard: `@fetchpier/core` must stay Electron-free and must never
  // import back into the desktop adapter (src/main) or the renderer. This is
  // the lint-time counterpart to the runtime no-electron smoke test.
  {
    files: ['packages/fetchpier-core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: '@fetchpier/core must not depend on Electron.'
            }
          ],
          patterns: [
            {
              group: [
                'electron',
                '@electron-toolkit/*',
                '**/src/main/**',
                '**/src/renderer/**',
                '**/src/preload/**'
              ],
              message:
                '@fetchpier/core must not import Electron, the desktop adapter (src/main), the preload, or the renderer.'
            }
          ]
        }
      ]
    }
  },

  // Boundary guard: `@fetchpier/cli` must stay Electron-free and may only reach
  // into the business layer (`@fetchpier/core`) and shared types (`@shared/*`).
  // It must never import the desktop adapter (src/main), preload, or renderer.
  {
    files: ['packages/fetchpier-cli/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: '@fetchpier/cli must not depend on Electron.'
            }
          ],
          patterns: [
            {
              group: [
                'electron',
                '@electron-toolkit/*',
                '**/src/main/**',
                '**/src/renderer/**',
                '**/src/preload/**'
              ],
              message:
                '@fetchpier/cli must not import Electron, the desktop adapter (src/main), the preload, or the renderer. Use @fetchpier/core and @shared/* only.'
            }
          ]
        }
      ]
    }
  },

  // Lazy-load guard for the schema-import secondary entry (REQ-0063). Only
  // `src/main/ipc/schema.ipc.ts` may reference `@fetchpier/core/schema-import`,
  // and only via dynamic `await import()` (which `no-restricted-imports` does
  // not lint) or `import type` (allowed by `allowTypeImports`). A static value
  // import here would defeat the cold-path optimization silently by pulling
  // openapi-parser/graphql/ajv/js-yaml into the main bundle at boot.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@fetchpier/core/schema-import',
              message:
                'Use dynamic `await import("@fetchpier/core/schema-import")` — only `src/main/ipc/schema.ipc.ts` may load this module, lazily, to keep its load cost off the main-process cold path. `import type` is allowed.',
              allowTypeImports: true
            }
          ]
        }
      ]
    }
  },

  // Build/dev scripts run in Node — expose Node globals there
  {
    files: ['scripts/**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },

  // Ignore build output and config files
  {
    ignores: [
      'out/**',
      'dist/**',
      '**/dist/**',
      'node_modules/**',
      // Generated test/coverage artifacts — never lint their minified bundles.
      'playwright-report/**',
      'coverage/**',
      'test-results/**',
      '*.config.{js,mjs,cjs,ts}',
      'electron.vite.config.ts',
      // Local, untracked agent/skill scaffolding. Not project source; some skill
      // assets ship their own nested `eslint.config.js` that imports plugins not
      // installed here, which would otherwise abort `eslint .` (ERR_MODULE_NOT_FOUND).
      '.claude/**'
    ]
  }
)
