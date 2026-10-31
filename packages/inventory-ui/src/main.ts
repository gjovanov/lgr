import { createApp } from 'vue'
import App from './App.vue'
import { registerPlugins, whenI18nReady } from 'ui-shared/plugins'
import { router } from './router/index'

const app = createApp(App)
registerPlugins(app, { router })
whenI18nReady().then(() => app.mount('#app'))
