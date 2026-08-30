/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // Everything under test today is the `platform` layer, which touches
    // `window`/`document`/`Notification` -- jsdom is the lightest
    // environment that gives us those. Do not add anything heavier
    // (a real browser, Playwright, etc.) without a concrete reason.
    environment: 'jsdom',
  },
})
