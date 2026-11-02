import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      include: [
        'src/main/**',
        'src/shared/**',
        'src/renderer/**',
        'packages/fetchpier-core/src/**',
        'packages/fetchpier-cli/src/**'
      ],
      exclude: [
        '**/*.md',
        // The v8 provider parses every included-but-unimported file as JS to
        // report it as uncovered; the renderer's entry HTML fails that parse
        // with a RollupError and self-excludes anyway. Excluding it up front
        // keeps the CI gate log free of two spurious parse errors.
        '**/*.html',
        '**/*.test.{ts,tsx,mts}',
        '**/*.spec.{ts,tsx,mts}',
        '**/*.generated*',
        '**/*.d.ts',
        'src/renderer/i18n/locales/**',
        'src/preload/**',
        'out/**',
        'dist/**',
        'test/**',
        'scripts/perf/**',
        '**/*.config.{ts,mts,js,mjs,cjs}'
      ]
    },
    projects: [
      {
        test: {
          name: 'main',
          include: ['src/main/**/*.{test,spec}.{ts,mts}', 'scripts/**/*.{test,spec}.{ts,mts}'],
          environment: 'node'
        },
        resolve: {
          alias: {
            '@shared': resolve(__dirname, 'src/shared'),
            '@fetchpier/core': resolve(__dirname, 'packages/fetchpier-core/src')
          }
        }
      },
      {
        test: {
          name: 'shared',
          include: ['src/shared/**/*.{test,spec}.{ts,mts}'],
          environment: 'node'
        },
        resolve: {
          alias: {
            '@shared': resolve(__dirname, 'src/shared')
          }
        }
      },
      {
        test: {
          name: 'core',
          include: ['packages/fetchpier-core/**/*.{test,spec}.{ts,mts}'],
          environment: 'node'
        },
        resolve: {
          alias: {
            '@shared': resolve(__dirname, 'src/shared'),
            '@fetchpier/core': resolve(__dirname, 'packages/fetchpier-core/src')
          }
        }
      },
      {
        test: {
          name: 'cli',
          include: ['packages/fetchpier-cli/**/*.{test,spec}.{ts,mts}'],
          environment: 'node',
          // The specs launch the BUILT CLI in a child process, so on a fresh
          // clone something must build it. Doing that here — once, before any
          // worker exists — instead of in each spec's `beforeAll`: parallel
          // workers otherwise all start their own `build:core && build:cli`,
          // and `tsup`'s `clean` makes them wipe each other's `dist/`. See the
          // file's header for the two CI failures that came out of it.
          globalSetup: resolve(__dirname, 'packages/fetchpier-cli/test/global-setup.ts')
        },
        resolve: {
          alias: {
            '@shared': resolve(__dirname, 'src/shared'),
            '@fetchpier/core': resolve(__dirname, 'packages/fetchpier-core/src'),
            '@fetchpier/cli': resolve(__dirname, 'packages/fetchpier-cli/src')
          }
        }
      },
      {
        test: {
          name: 'e2e-helpers',
          // ONLY `*.test.ts` — never `*.spec.ts`. The Playwright/Electron specs
          // live in this same directory under `.spec.ts` and must not be picked
          // up by Vitest (they would launch Electron out of band and fail).
          // The split is: `.spec.ts` → Playwright, `.test.ts` → Vitest.
          //
          // This project exists because no other glob covers `test/**`, so a
          // harness test placed next to its source would silently never run
          // (`passWithNoTests: true` hides an empty match). It contributes no
          // coverage: `coverage.exclude` already lists `test/**`, and
          // `scripts/post-req.mjs` only scores projects present in the baseline.
          include: ['test/e2e/**/*.test.{ts,mts}'],
          environment: 'node'
        }
      },
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          include: ['src/renderer/**/*.{test,spec}.{ts,tsx,mts}'],
          environment: 'jsdom',
          // Above Vitest's 5 s default. These are jsdom component tests, and
          // under `--coverage` the v8 instrumentation roughly triples transform
          // and import time; the heaviest of them (EnvironmentManager,
          // CertificatesPanel) crossed 5 s on a busy machine and turned the
          // gate red with no logic defect. CI runners are slower than a dev
          // box, so the default has no margin there at all. A raised ceiling
          // costs nothing on a passing test — it only bounds a genuine hang.
          testTimeout: 15_000
        },
        resolve: {
          alias: {
            '@renderer': resolve(__dirname, 'src/renderer'),
            '@shared': resolve(__dirname, 'src/shared')
          }
        }
      }
    ]
  }
})
