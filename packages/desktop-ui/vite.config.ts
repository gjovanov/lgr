import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'
import { fileURLToPath, URL } from 'node:url'

/**
 * The shell's own pages. It imports no domain UI (FR-14.8), so there are no cross-package
 * aliases left to maintain.
 *
 * ⚠ What was here: an alias table redirecting every `*-ui/src/store/app.store.ts` import to
 * this package's own store, so that `logout()` went to the local login form instead of the
 * Portal. It listed `hr`, `crm` and `erp` — modules that no longer exist — which is the shape
 * dead configuration takes when nothing builds the package. It is gone with local mode
 * (FR-14.34); the cloud app runs in its own window now, served by the cloud.
 *
 * The dev server no longer proxies `/api`: the shell's pages talk to no API of their own, and
 * the one it will talk to (registration, tokens, `/ws/desktop`) is reached from Rust with the
 * system proxy and the OS trust store (FR-14.32), never through Vite.
 */
export default defineConfig({
  plugins: [
    vue(),
    vuetify({ autoImport: true }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 4081,
  },
})
