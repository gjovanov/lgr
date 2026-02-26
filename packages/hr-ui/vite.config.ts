import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'
import { resolve } from 'path'

export default defineConfig(({ command }) => ({
  base: '/hr/',
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
    port: 4051,
    proxy: {
      '/api': {
        target: 'http://localhost:4050',
        changeOrigin: true,
      },
    },
  },
}))
