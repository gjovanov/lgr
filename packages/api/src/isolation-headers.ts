import { Elysia } from 'elysia'

/**
 * lgrai.app keeps its responses to itself (FR-20.72, plan step P0a-8).
 *
 * An org's address (`<org slug>.lgrai.app`) is answered by the org's own server, which may be a
 * customer's machine. That makes it a sibling origin of lgrai.app, on the same site. These two
 * headers, on every response, stop a page there from borrowing lgrai.app's responses:
 *
 * - **`Cross-Origin-Resource-Policy: same-origin`.** No other origin, a sibling subdomain included,
 *   can load a response as an image, script, style or any other no-cors resource. Nothing does
 *   today: e-mails embed nothing from lgrai.app, PDFs carry the org logo as a data URI, and the
 *   portal fetches the logo with its bearer token into a blob. CORS requests are unaffected.
 * - **`Origin-Agent-Cluster: ?1`.** The browser isolates this origin's agent cluster by origin
 *   rather than by site, so a same-site page cannot share one with it through `document.domain`.
 *
 * Set in `onRequest`, so it reaches every response the server sends: the API, the SPAs' static
 * files, the SPA shell the error handler serves, and a `Response` a handler returns itself, such as
 * a redirect or a download.
 */
export function isolationHeaders() {
  return new Elysia({ name: 'isolation-headers' }).onRequest(({ set }) => {
    set.headers['cross-origin-resource-policy'] = 'same-origin'
    set.headers['origin-agent-cluster'] = '?1'
  })
}
