/**
 * Which node serves this page (FR-20, gjovanov/lgr#384).
 *
 * A master marks the portal's shell with `<meta name="lgr-node" content="master">`
 * (`portal-api/src/spa-fallback.ts#portalShellFor`). Nothing marks lgrai.app's, and a page Vite
 * serves in development is lgrai.app's too.
 *
 * ⚠ It decides only what a visitor nobody signed in is SHOWN first. It is no permission: the
 * server enforces every route by itself, and a page that read "master" anywhere else could be
 * told anything by its own address bar.
 */
export const NODE_META = 'lgr-node'

/** The tag a master's portal shell carries, exactly as `portalShellFor` writes it. */
export const MASTER_NODE_TAG = `<meta name="${NODE_META}" content="master">`

export function servedByMaster(doc: Pick<Document, 'querySelector'> | undefined = globalThis.document): boolean {
  return doc?.querySelector(`meta[name="${NODE_META}"]`)?.getAttribute('content') === 'master'
}
