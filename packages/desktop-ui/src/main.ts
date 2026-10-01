import { createApp } from 'vue'
import App from './App.vue'
import { registerPlugins } from 'ui-shared/plugins'
import { router } from './router/index'
import { createShellI18n } from './plugins/i18n'

const app = createApp(App)
// ⚠ The shell's OWN catalogue (FR-14.33), handed to `registerPlugins` rather than merged into
// the portal's. See `plugins/i18n.ts` for why, and for why `$vuetify` still has to be in it.
registerPlugins(app, { router, i18n: createShellI18n() })
app.mount('#app')
