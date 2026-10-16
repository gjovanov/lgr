import { Elysia } from 'elysia'
import { logger } from 'services/logger'
import {
  classifyDesktopAsset,
  DesktopDownloadError,
  findDesktopRelease,
  openDesktopAsset,
  type DesktopReleaseAsset,
} from 'services/biz/desktop/release-download'

/**
 * Where a till operator downloads LGR Desktop — the link the hub offers with an update.
 *
 * ⚠ PUBLIC (`services/biz/public-routes.ts`). The person clicking it is in the system browser,
 * not signed in, and often on the very machine that needs the installer before it can sign in at
 * all. What it serves is signed installers of a PUBLISHED release, which is what any desktop
 * app's download page serves; `release-download.ts` is where the narrowing lives.
 */

const LABELS: Record<'en' | 'bg', Record<string, string>> = {
  en: {
    title: 'LGR Desktop',
    intro: 'Download the installer for this computer.',
    notFound: 'There is no published LGR Desktop release with this version.',
    notConfigured: 'Downloads are not configured on this server. Ask your administrator for the installer.',
    upstream: 'The download is temporarily unavailable. Try again in a few minutes.',
    'win-setup': 'Windows — installer (this user, no admin rights needed)',
    'win-msi': 'Windows — MSI (whole machine, deployed by IT)',
    'mac-arm': 'macOS — Apple Silicon',
    'mac-intel': 'macOS — Intel',
    'linux-deb': 'Linux — .deb (Debian, Ubuntu)',
    'linux-rpm': 'Linux — .rpm (Fedora, RHEL)',
    signature: 'signature',
    pubkey: 'Release signing key (to verify the .asc signatures)',
  },
  bg: {
    title: 'LGR Desktop',
    intro: 'Изтеглете инсталатора за този компютър.',
    notFound: 'Няма публикувана версия на LGR Desktop с този номер.',
    notConfigured: 'Изтеглянето не е настроено на този сървър. Поискайте инсталатора от администратора.',
    upstream: 'Изтеглянето временно не е достъпно. Опитайте отново след няколко минути.',
    'win-setup': 'Windows — инсталатор (за този потребител, без администраторски права)',
    'win-msi': 'Windows — MSI (за цялата машина, инсталира се от ИТ)',
    'mac-arm': 'macOS — Apple Silicon',
    'mac-intel': 'macOS — Intel',
    'linux-deb': 'Linux — .deb (Debian, Ubuntu)',
    'linux-rpm': 'Linux — .rpm (Fedora, RHEL)',
    signature: 'подпис',
    pubkey: 'Ключ за подписите (за проверка на .asc файловете)',
  },
}

function lang(request: Request): 'en' | 'bg' {
  return (request.headers.get('accept-language') || '').toLowerCase().startsWith('bg') ? 'bg' : 'en'
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function mb(bytes: number): string {
  return bytes > 0 ? `${(bytes / 1_048_576).toFixed(1)} MB` : ''
}

function page(l: 'en' | 'bg', heading: string, body: string): string {
  return `<!doctype html><html lang="${l}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(heading)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 32px 16px; color: #1f2933; background: #f7f8fa; }
  main { max-width: 640px; margin: 0 auto; background: #fff; border: 1px solid #e4e7eb; border-radius: 8px; padding: 24px; }
  h1 { font-size: 1.4rem; margin: 0 0 8px; }
  p { margin: 0 0 16px; color: #52606d; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 10px 0; border-top: 1px solid #eef0f3; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  a.dl { font-weight: 600; color: #1d4ed8; text-decoration: none; }
  a.dl:hover { text-decoration: underline; }
  .sig { font-size: .85rem; color: #52606d; }
  .size { font-size: .85rem; color: #7b8794; }
</style></head><body><main>
<h1>${esc(heading)}</h1>
${body}
</main></body></html>`
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

function listing(l: 'en' | 'bg', version: string, assets: DesktopReleaseAsset[]): string {
  const t = LABELS[l]
  const href = (name: string) => `/api/desktop/download/${version}/${encodeURIComponent(name)}`
  const sigs = new Map(assets.filter(a => a.name.endsWith('.asc')).map(a => [a.name.slice(0, -4), a]))
  // Signatures ride beside their file, and updater archives are for the desktop, not a person.
  const rows = assets
    .filter(a => !['signature', 'updater'].includes(classifyDesktopAsset(a.name)!.label))
    .map(a => {
      const kind = classifyDesktopAsset(a.name)!
      const sig = sigs.get(a.name)
      return `<li><a class="dl" href="${href(a.name)}">${esc(t[kind.label])}</a>`
        + `<span class="size">${esc(a.name)} ${mb(a.size)}</span>`
        + (sig ? ` <a class="sig" href="${href(sig.name)}">${esc(t.signature)}</a>` : '')
        + '</li>'
    })
  return `<p>${esc(t.intro)}</p><ul>${rows.join('')}</ul>`
}

function failPage(l: 'en' | 'bg', version: string, e: unknown): Response {
  const t = LABELS[l]
  if (e instanceof DesktopDownloadError) {
    const msg = e.code === 'not_configured' ? t.notConfigured : e.code === 'upstream' ? t.upstream : t.notFound
    return html(page(l, `${t.title} ${version}`, `<p>${esc(msg)}</p>`), e.statusCode)
  }
  throw e
}

export const desktopDownloadController = new Elysia({ prefix: '/desktop/download' })
  .get('/:version', async ({ params, request }) => {
    const l = lang(request)
    const t = LABELS[l]
    try {
      const assets = await findDesktopRelease(params.version)
      if (!assets?.length) throw new DesktopDownloadError(404, 'not_found', 'no release')
      return html(page(l, `${t.title} ${params.version}`, listing(l, params.version, assets)))
    } catch (e) {
      return failPage(l, params.version, e)
    }
  })
  .get('/:version/:file', async ({ params, request }) => {
    try {
      const { asset, body, length } = await openDesktopAsset(params.version, params.file)
      const headers: Record<string, string> = {
        'Content-Type': /\.(asc|sig)$/.test(asset.name) ? 'text/plain; charset=utf-8' : 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${asset.name}"`,
        // A version's files never change once published.
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      }
      if (length) headers['Content-Length'] = length
      return new Response(body, { status: 200, headers })
    } catch (e) {
      if (e instanceof DesktopDownloadError && e.statusCode !== 404) {
        logger.warn({ version: params.version, file: params.file, code: e.code, err: e.message }, 'desktop download failed')
      }
      return failPage(lang(request), params.version, e)
    }
  })
