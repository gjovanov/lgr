import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [
    vue(),
    vuetify({ autoImport: true }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Redirect all domain-ui app.store imports to desktop-ui's version
      // This ensures logout() redirects to /auth/login, not Portal
      ...Object.fromEntries(
        ['accounting', 'trade', 'payroll', 'hr', 'crm', 'erp'].map(mod => [
          fileURLToPath(new URL(`../${mod}-ui/src/store/app.store.ts`, import.meta.url)),
          fileURLToPath(new URL('./src/store/app.store.ts', import.meta.url)),
        ]),
      ),
    },
  },
  server: {
    port: 4081,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4080',
        changeOrigin: true,
      },
    },
  },
})
