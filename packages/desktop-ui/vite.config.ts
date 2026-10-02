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
  /**
   * ⚠ **vue-i18n must not compile messages with `new Function`, or the shell renders EMPTY.**
   *
   * C08 gave `lgr-web`'s host a strict CSP with `script-src 'self'` and no `'unsafe-eval'`. By
   * default vue-i18n compiles each message string into a function with `new Function`
   * (`@intlify/core-base`'s `compile`), which that CSP forbids — so **every `$t()` threw an
   * EvalError**, and because the translations are prop bindings, the navigation drawer's items and
   * the whole body of all five views rendered as nothing. The window came up showing a bare drawer
   * and the version number.
   *
   * ⚠ **It shipped, and nothing caught it.** C08 proved the CSP by the `shell_ready` log line —
   * which only shows the module executed and the app mounted, both of which happened. The first
   * thing to see it was C15's CDP walk, which asserts real DOM per view. That is the difference
   * between "a page loaded" and "the page works".
   *
   * With JIT compilation on, a message is parsed into an **AST** and interpreted by `format(ast)`
   * — ordinary JavaScript, no code generation — which is the documented way to run vue-i18n under
   * a CSP that forbids `unsafe-eval`. The eval branch stays in the bundle but is unreachable.
   *
   * ⚠ Only this package needs it. The other nine UIs are served by the cloud, which sets no such
   * CSP; relaxing the shell's CSP instead would have given a REMOTE origin `unsafe-eval`, which is
   * the opposite of what C08 was for.
   */
  define: {
    __INTLIFY_JIT_COMPILATION__: 'true',
    __INTLIFY_DROP_MESSAGE_COMPILER__: 'false',
  },
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
