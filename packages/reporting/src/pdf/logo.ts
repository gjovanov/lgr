import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import logoFile from '../assets/logo.png' with { type: 'file' }

/**
 * Letterhead logo for the printed forms — the invoice and the document-list report.
 *
 * The bundled fallback is embedded as a data URI: Chromium renders the forms from a string
 * with no base URL, so a file path would not resolve, and the renderer has no reason to be
 * granted network access. Read once per process; `null` means the asset is missing and the
 * header simply prints without a logo.
 *
 * The file import makes a server bundle carry the asset (FR-20 plan step P0b-9). Run from
 * source it is the asset's absolute path. Bundled, it is a path relative to the bundle, which
 * `bun build` copies the asset next to, so it is resolved against this module and never
 * against the working directory.
 */
let bundledLogo: string | null | undefined

export function bundledLogoDataUri(): string | null {
  if (bundledLogo === undefined) {
    try {
      const bytes = readFileSync(isAbsolute(logoFile) ? logoFile : join(import.meta.dir, logoFile))
      bundledLogo = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
    } catch {
      bundledLogo = null
    }
  }
  return bundledLogo
}

/**
 * The tenant's own logo wins when it is something Chromium can render on its own (a data URI
 * or an absolute URL); anything else — an empty field, a storage key, a relative path — falls
 * back to the bundled asset.
 */
export function resolveLogo(logo: unknown): string | null {
  const own = String(logo ?? '').trim()
  if (own.startsWith('data:') || /^https?:\/\//i.test(own)) return own
  return bundledLogoDataUri()
}

/** `<img>` for the resolved logo, or an empty string when there is none. */
export function logoImgTag(logo: unknown): string {
  const src = resolveLogo(logo)
  return src ? `<img class="org-logo" src="${src}" alt="" />` : ''
}

/** Shared letterhead styling: its own line at the top of the form, logo at the left. */
export const LOGO_CSS = `
  .logo-bar { margin: 0 0 16px 0; }
  img.org-logo { max-height: 17mm; max-width: 45mm; margin: 0 auto 0 0; display: block; }
`
