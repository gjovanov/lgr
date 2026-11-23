/**
 * What an org's address answers when it does not tunnel (FR-20.72, FR-20.75): a short static page,
 * never a sign-in page, and nothing of lgrai.app's app.
 *
 * - **unknown** (404): no such address, or an org that lives on lgrai.app: exactly alike, so the
 *   page says nothing about which org has an address.
 * - **retired** (410): the address was retired; it says so for 12 months.
 * - **offline** (503): the org's server is not connected. The shop works on its own network.
 * - **busy** (503): too many requests open, or too many anonymous ones.
 */
export type NoticeKind = 'unknown' | 'retired' | 'offline' | 'busy'

const TEXT: Record<NoticeKind, { status: number; en: [string, string]; bg: [string, string] }> = {
  unknown: {
    status: 404,
    en: ['No such address', 'There is no organization at this address.'],
    bg: ['Няма такъв адрес', 'На този адрес няма организация.'],
  },
  retired: {
    status: 410,
    en: ['This address was retired', 'The organization that used it is no longer reached here.'],
    bg: ['Този адрес е оттеглен', 'Организацията, която го е ползвала, вече не се достига оттук.'],
  },
  offline: {
    status: 503,
    en: ['The organization\'s server is not connected', 'It cannot be reached from here right now. In the shop, LGR keeps working on its own network. Try again later.'],
    bg: ['Сървърът на организацията не е свързан', 'В момента не може да бъде достигнат оттук. В обекта LGR продължава да работи в своята мрежа. Опитайте отново по-късно.'],
  },
  busy: {
    status: 503,
    en: ['Too many requests', 'The organization\'s server is busy. Try again in a minute.'],
    bg: ['Твърде много заявки', 'Сървърът на организацията е зает. Опитайте отново след минута.'],
  },
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function noticeResponse(kind: NoticeKind, accept: string | null): Response {
  const t = TEXT[kind]
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    ...(kind === 'offline' || kind === 'busy' ? { 'retry-after': '60' } : {}),
  }
  // An API client gets JSON it can read; a browser gets the page.
  if ((accept ?? '').includes('application/json') && !(accept ?? '').includes('text/html')) {
    return Response.json({ code: `address_${kind}`, message: t.en[1] }, { status: t.status, headers })
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.en[0])}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#1d2433}main{max-width:32rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.25rem 0 1rem;line-height:1.5}.bg{color:#4a5468;border-top:1px solid #dde1e8;padding-top:1rem}@media (prefers-color-scheme:dark){body{background:#12151c;color:#e6e9ef}.bg{color:#a9b1c2;border-color:#2a3040}}</style></head>
<body><main><h1>${esc(t.en[0])}</h1><p>${esc(t.en[1])}</p><div class="bg" lang="bg"><h1>${esc(t.bg[0])}</h1><p>${esc(t.bg[1])}</p></div></main></body></html>`
  return new Response(html, { status: t.status, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } })
}
