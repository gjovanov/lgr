import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'

/**
 * FR-24.10: the one SPA. `base: '/'`, and its own asset directory (`/ui/`), because the portal's
 * `/assets/` is still served beside it until Phase 3 deletes the seven builds.
 */

/** FR-24.14: the build's id, in `index.html` (the server sends it back as `x-lgr-build`). */
const BUILD_ID = process.env.LGR_BUILD_ID || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function buildId(): Plugin {
  return {
    name: 'lgr-build-id',
    transformIndexHtml: html => html.replace('</head>', `  <meta name="lgr-build" content="${BUILD_ID}">\n  </head>`),
  }
}

export default defineConfig({
  base: '/',
  plugins: [vue(), vuetify({ autoImport: true }), buildId()],
  // One copy of each: Bun's isolated install can resolve a package once per peer set, and two
  // Vuetify or Vue instances in one app is both bigger and broken (provide/inject across them).
  resolve: {
    dedupe: ['vue', 'vuetify', 'vue-router', 'pinia', 'vue-i18n', 'axios'],
  },
  build: {
    assetsDir: 'ui',
  },
  server: {
    port: 4200,
    proxy: {
      '/api': { target: 'http://localhost:4001', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4001', ws: true },
    },
  },
})