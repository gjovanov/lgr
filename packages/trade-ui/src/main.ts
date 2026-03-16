import { createApp } from 'vue'
import App from './App.vue'
import { registerPlugins } from 'ui-shared/plugins'
import { router } from './router/index'

const app = createApp(App)
registerPlugins(app, { router })
app.mount('#app')
