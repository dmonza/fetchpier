import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          activityPanelPopout: resolve(__dirname, 'src/renderer/activity-panel-popout.html')
        },
        output: {
          manualChunks: {
            codemirror: [
              '@codemirror/view',
              '@codemirror/state',
              '@codemirror/commands',
              '@codemirror/language',
              '@codemirror/lang-json',
              '@codemirror/lang-html',
              '@codemirror/theme-one-dark',
              '@uiw/codemirror-theme-github',
              '@uiw/codemirror-theme-dracula'
            ]
          }
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared'),
        // Pure neutral activity-log module — bundled from source so the
        // renderer never pulls in the Node-using parts of `@fetchpier/core`.
        '@fetchpier/core/activity-log': resolve('packages/fetchpier-core/src/activity-log/index.ts')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
