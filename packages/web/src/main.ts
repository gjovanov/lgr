import { createApp } from 'vue'
import App from './App.vue'
import { registerPlugins, whenI18nReady } from 'ui-shared/plugins'
import { router } from './router'
import { installChunkRecovery, watchBuild } from './stale'

// FR-24.10: the one SPA — the portal and every module, one Vue app, one router, one Pinia, one bridge.
const app = createApp(App)
registerPlugins(app, { router })
watchBuild()
installChunkRecovery(router)
whenI18nReady().then(() => {
  app.mount('#app')
  // FR-24.14: the entry loaded; index.html's bounded retry starts over on the next failure.
  sessionStorage.removeItem('lgr_boot_retry')
})
