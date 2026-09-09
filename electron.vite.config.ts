import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve('electron/main.ts') },
      // package.json `main` points at out/main/index.js, so pin the name.
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } },
    },
    resolve: { alias: { '@shared': resolve('shared') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve('electron/preload.ts') },
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } },
    },
    resolve: { alias: { '@shared': resolve('shared') } },
  },
  renderer: {
    root: resolve('renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('shared'),
        '@': resolve('renderer/src'),
      },
    },
    build: {
      outDir: resolve('out/renderer'),
      rollupOptions: { input: resolve('renderer/index.html') },
    },
  },
})
