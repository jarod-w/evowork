/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@evowork/protocol': fileURLToPath(
        new URL('../../packages/protocol/generated/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    // jsdom covers `window`/`document` for platform + workspace component tests.
    // Do not add anything heavier (a real browser, Playwright, etc.) without
    // a concrete reason.
    environment: 'jsdom',
  },
})
