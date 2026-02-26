import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'
import { resolve } from 'path'

export default defineConfig(({ command }) => ({
  base: '/warehouse/',
  plugins: [
    vue(),
    vuetify({ autoImport: true }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 4031,
    proxy: {
      '/api': {
        target: 'http://localhost:4030',
        changeOrigin: true,
      },
    },
  },
}))
