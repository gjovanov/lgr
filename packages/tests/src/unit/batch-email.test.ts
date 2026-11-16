import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOC_EMAIL_FAILURES, DOC_EMAIL_SKIPS, NO_PARTNER, type DocEmailPreviewRow } from 'config/doc-email'
import { shortList, stopsTheBatch, useBatchEmail } from 'ui-shared/composables/useBatchEmail'

/**
 * E-mailing a list's ticked documents (2026-11-16): what `BatchEmailDialog` does, asked of its composable with a
 * stand-in for the server. Who is mailed which documents is `config/doc-email`'s (`unit/doc-email.test.ts`); here it
 * is the order of the requests, what stops a batch, what leaves the list's selection, and when the one address is
 * remembered.
 */

const ORG = '/org/o1'
const row = (id: string, partner?: { id: string; email?: string }, more: Partial<DocEmailPreviewRow> = {}): DocEmailPreviewRow => ({
  id, number: `DOC-${id}`, docType: 'invoice', status: 'sent',
  ...(partner ? { partner: { id: partner.id, name: `Partner ${partner.id}`, ...(partner.email ? { email: partner.email } : {}) } } : {}),
  ...more,
})
const refused = (status: number, data: Record<string, unknown> = {}) => Object.assign(new Error('refused'), { response: { status, data } })

/** The two endpoints, stood in for: the preview answers `rows`, a mail request what `answer` makes of it (all sent, by default). */
function server(rows: DocEmailPreviewRow[], answer?: (body: any, nth: number) => any) {
  const calls: Array<{ url: string; body: any }> = []
  let active = 0
  let most = 0
  let mails = 0
  const post = async <T>(url: string, body: any): Promise<{ data: T }> => {
    calls.push({ url, body })
    if (url.endsWith('/preview')) return { data: { documents: rows } as T }
    active++
    most = Math.max(most, active)
    await new Promise(r => setTimeout(r, 1))
    active--
    const made = answer?.(body, mails++)
    if (made instanceof Error) throw made
    return {
      data: (made ?? {
        to: body.to, mails: 1, queued: false,
        results: body.items.map((i: any) => ({ ...i, number: `DOC-${i.id}`, status: 'sent' })),
      }) as T,
    }
  }
  return { calls, post, mailRequests: () => calls.filter(c => !c.url.endsWith('/preview')), atOnce: () => most }
}

function memory(value: string | null = null) {
  return { value, read() { return this.value }, write(v: string) { this.value = v } }
}

function dialog(s: ReturnType<typeof server>, more: Record<string, unknown> = {}) {
  return useBatchEmail({
    kind: () => 'invoice',
    orgUrl: () => ORG,
    previewPath: () => '/x/email/preview',
    emailPath: () => '/x/email',
    post: s.post,
    remembered: memory(),
    ...more,
  })
}

describe('opening the dialog', () => {
  it('asks the preview, and starts on the partners with the address on each card', async () => {
    const s = server([
      row('a1', { id: 'p1', email: 'one@buyer.test' }),
      row('a2', { id: 'p1', email: 'one@buyer.test' }),
      row('b1', { id: 'p2' }),
      row('c1'),
      row('d1', { id: 'p1', email: 'one@buyer.test' }, { blocked: 'draft', status: 'draft' }),
    ])
    const remembered = memory('accountant@office.test')
    const d = dialog(s, { remembered, defaultSubject: (rows: DocEmailPreviewRow[]) => `${rows.length} to go` })

    await d.open(['a1', 'a2', 'b1', 'c1', 'd1'])

    expect(s.calls).toEqual([{ url: '/org/o1/x/email/preview', body: { kind: 'invoice', ids: ['a1', 'a2', 'b1', 'c1', 'd1'] } }])
    expect(d.phase.value).toBe('compose')
    expect(d.mode.value).toBe('partner')
    expect(d.hasPartner.value).toBe(true)
    expect(d.groups.value.map(g => [g.key, g.rows.map(r => r.id)])).toEqual([['p1', ['a1', 'a2']], ['p2', ['b1']], [NO_PARTNER, ['c1']]])
    expect({ ...d.addresses }).toEqual({ p1: 'one@buyer.test', p2: '', [NO_PARTNER]: '' })
    expect(d.blocked.value.map(r => r.id)).toEqual(['d1'])
    // The one address waits behind the other option, as this person left it.
    expect(d.singleTo.value).toBe('accountant@office.test')
    expect(d.subject.value).toBe('4 to go')
    // Two of the four that may go have an address: that is what the button says.
    expect(d.totals.value).toEqual({ documents: 2, recipients: 1, requests: 1 })
    expect(d.plan.value.unaddressed.map(r => r.id)).toEqual(['b1', 'c1'])
    expect(d.canSend.value).toBe(true)
  })

  it('starts on the one address when no document has a customer or a supplier', async () => {
    const d = dialog(server([row('c1'), row('c2')]))
    await d.open(['c1', 'c2'])
    expect(d.hasPartner.value).toBe(false)
    expect(d.mode.value).toBe('single')
    // Nothing typed yet: nothing to send.
    expect(d.canSend.value).toBe(false)
    d.singleTo.value = 'colleague@office.test'
    expect(d.totals.value).toEqual({ documents: 2, recipients: 1, requests: 1 })
    expect(d.canSend.value).toBe(true)
  })

  it('an address that is no address blocks the batch, in either mode', async () => {
    const d = dialog(server([row('a1', { id: 'p1', email: 'one@buyer.test' }), row('b1', { id: 'p2', email: 'two@buyer.test' })]))
    await d.open(['a1', 'b1'])
    d.addresses.p2 = 'two@buyer'
    expect(d.plan.value.invalid).toEqual(['p2'])
    expect(d.canSend.value).toBe(false)
    d.addresses.p2 = ''
    expect(d.canSend.value).toBe(true)
    d.mode.value = 'single'
    d.singleTo.value = 'nobody'
    expect(d.canSend.value).toBe(false)
  })

  it('a preview the server refuses is said in its words, and nothing can be sent', async () => {
    const s = server([])
    const post = async () => { throw refused(409, { message: 'This organization is written on its server.' }) }
    const d = dialog(s, { post })
    await d.open(['a1'])
    expect(d.phase.value).toBe('compose')
    expect(d.loadFailed.value).toBe(true)
    expect(d.loadError.value).toBe('This organization is written on its server.')
    expect(d.canSend.value).toBe(false)
    expect(await d.send()).toBeNull()
  })

  it('opened again while a preview is on its way, it keeps the later answer', async () => {
    let release: (v: unknown) => void = () => {}
    const slow = new Promise(r => { release = r })
    let nth = 0
    const post = async <T>(_url: string, body: any): Promise<{ data: T }> => {
      if (nth++ === 0) await slow
      return { data: { documents: body.ids.map((id: string) => row(id, { id: 'p1', email: 'one@buyer.test' })) } as T }
    }
    const d = dialog(server([]), { post })
    const first = d.open(['old'])
    await d.open(['new'])
    release(null)
    await first
    expect(d.sendable.value.map(r => r.id)).toEqual(['new'])
    expect(d.phase.value).toBe('compose')
  })

  it('every open starts clean: the last batch leaves no address, message or result behind', async () => {
    const s = server([row('a1', { id: 'p1', email: 'one@buyer.test' })])
    const d = dialog(s)
    await d.open(['a1'])
    d.addresses.p1 = 'other@buyer.test'
    d.message.value = 'As agreed.'
    await d.send()
    expect(d.phase.value).toBe('done')

    await d.open(['a1'])
    expect({ ...d.addresses }).toEqual({ p1: 'one@buyer.test' })
    expect(d.message.value).toBe('')
    expect(d.results.value).toEqual([])
    expect({ ...d.progress }).toEqual({ done: 0, total: 0 })
  })
})

describe('mailing the batch', () => {
  it('one address: ten documents at most to a request, one request after the other, with what the dialog says', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `d${i + 1}`)
    const s = server(ids.map(id => row(id, { id: 'p1', email: 'one@buyer.test' })))
    const d = dialog(s, { locale: () => 'bg', columns: () => ['description', 'quantity'] })
    await d.open(ids)
    d.mode.value = 'single'
    d.singleTo.value = '  accountant@office.test '
    d.subject.value = ' November '
    d.message.value = ''
    expect(d.totals.value).toEqual({ documents: 12, recipients: 1, requests: 2 })

    const outcome = await d.send()

    const mails = s.mailRequests()
    expect(mails.map(m => m.url)).toEqual(['/org/o1/x/email', '/org/o1/x/email'])
    expect(mails.map(m => m.body.items.map((i: any) => i.id))).toEqual([ids.slice(0, 10), ids.slice(10)])
    expect(mails[0]!.body).toMatchObject({ kind: 'invoice', to: 'accountant@office.test', subject: 'November', locale: 'bg', columns: ['description', 'quantity'] })
    // An empty message is not sent as one, and an invoice's item carries no group.
    expect('message' in mails[0]!.body && mails[0]!.body.message !== undefined).toBe(false)
    expect(mails[0]!.body.items[0]).toEqual({ id: 'd1' })
    expect(s.atOnce()).toBe(1)
    expect({ ...d.progress }).toEqual({ done: 2, total: 2 })
    expect(d.phase.value).toBe('done')
    expect(outcome).toEqual({ went: ids, documents: 12, recipients: 1, queued: false, allFine: true })
  })

  it('to the partners: a request per address in the lines\' order, a typed-over address, and a line left empty stays behind', async () => {
    const s = server([
      row('a1', { id: 'p1', email: 'one@buyer.test' }),
      row('b1', { id: 'p2', email: 'two@buyer.test' }),
      row('a2', { id: 'p1', email: 'one@buyer.test' }),
      row('c1', { id: 'p3' }),
    ])
    const remembered = memory()
    const d = dialog(s, { remembered })
    await d.open(['a1', 'b1', 'a2', 'c1'])
    d.addresses.p2 = 'purchasing@two.test'

    const outcome = await d.send()

    expect(s.mailRequests().map(m => [m.body.to, m.body.items.map((i: any) => i.id)])).toEqual([
      ['one@buyer.test', ['a1', 'a2']],
      ['purchasing@two.test', ['b1']],
    ])
    expect(outcome).toEqual({ went: ['a1', 'b1', 'a2'], documents: 3, recipients: 2, queued: false, allFine: true })
    expect(d.results.value.map(r => [r.to, r.results.map(x => x.status)])).toEqual([
      ['one@buyer.test', ['sent', 'sent']], ['purchasing@two.test', ['sent']],
    ])
    // A partner's address is its own: it is not what „До един адрес" starts with next time.
    expect(remembered.value).toBeNull()
  })

  it('two lines typed to one address share its mails', async () => {
    const s = server([row('a1', { id: 'p1', email: 'one@buyer.test' }), row('b1', { id: 'p2', email: 'two@buyer.test' })])
    const d = dialog(s)
    await d.open(['a1', 'b1'])
    d.addresses.p2 = 'ONE@buyer.test'
    expect(d.totals.value).toEqual({ documents: 2, recipients: 1, requests: 1 })
    await d.send()
    expect(s.mailRequests().map(m => [m.body.to, m.body.items.map((i: any) => i.id)])).toEqual([['one@buyer.test', ['a1', 'b1']]])
  })

  it('a supplier order goes sheet by sheet, and stays ticked until every sheet has gone', async () => {
    const rows = [
      row('o1', { id: 's1', email: 'orders@one.test' }, { groupId: 'g1', docType: 'order' }),
      row('o1', { id: 's2' }, { groupId: 'g2', docType: 'order' }),
      row('o2', { id: 's1', email: 'orders@one.test' }, { groupId: 'g3', docType: 'order' }),
    ]
    const s = server(rows)
    const d = dialog(s, { kind: () => 'order' })
    await d.open(['o1', 'o2'])

    const outcome = await d.send()

    expect(s.mailRequests().map(m => m.body)).toEqual([
      { kind: 'order', to: 'orders@one.test', items: [{ id: 'o1', groupId: 'g1' }, { id: 'o2', groupId: 'g3' }], subject: undefined, message: undefined, locale: undefined, columns: undefined },
    ])
    // The second supplier of `o1` has no address: its sheet stayed, and so the order stays ticked.
    expect(outcome!.went).toEqual(['o2'])
    expect(outcome!.allFine).toBe(true)
  })

  it('what went leaves the selection, what did not stays, and the dialog is told it is not all fine', async () => {
    const s = server(
      [row('a1', { id: 'p1', email: 'one@buyer.test' }), row('a2', { id: 'p1', email: 'one@buyer.test' }), row('a3', { id: 'p1', email: 'one@buyer.test' })],
      body => ({
        to: body.to, mails: 1, queued: false,
        results: [
          { id: 'a1', number: 'DOC-a1', status: 'sent' },
          { id: 'a2', number: 'DOC-a2', status: 'skipped', reason: 'just_sent' },
          { id: 'a3', number: 'DOC-a3', status: 'failed', reason: 'render_failed', message: 'PDF renderer unavailable' },
        ],
      }),
    )
    const d = dialog(s)
    await d.open(['a1', 'a2', 'a3'])

    const outcome = await d.send()

    expect(outcome).toEqual({ went: ['a1'], documents: 1, recipients: 1, queued: false, allFine: false })
    expect(d.halted.value).toBe(false)
    expect(d.results.value[0]!.results.map(r => [r.id, r.status, r.reason])).toEqual([
      ['a1', 'sent', undefined], ['a2', 'skipped', 'just_sent'], ['a3', 'failed', 'render_failed'],
    ])
  })

  it('on an organization\'s own server the mails are queued, and that is all fine too', async () => {
    const s = server([row('a1', { id: 'p1', email: 'one@buyer.test' })], body => ({
      to: body.to, mails: 1, queued: true, results: [{ id: 'a1', number: 'DOC-a1', status: 'queued' }],
    }))
    const d = dialog(s)
    await d.open(['a1'])
    expect(await d.send()).toEqual({ went: ['a1'], documents: 1, recipients: 1, queued: true, allFine: true })
    expect(d.results.value[0]!.queued).toBe(true)
  })
})

describe('a refusal about the whole batch', () => {
  const three = () => [
    row('a1', { id: 'p1', email: 'one@buyer.test' }),
    row('b1', { id: 'p2', email: 'two@buyer.test' }),
    row('c1', { id: 'p3', email: 'three@buyer.test' }),
  ]

  // The last column: the reason its rows carry. Only a code the catalogue has words for becomes one.
  for (const [name, error, words, reason] of [
    ['mail is not set up on this server', refused(503, { code: 'not_configured', message: 'Email is not configured on this server' }), 'Email is not configured on this server', 'not_configured'],
    ['the session is gone', refused(401, { message: 'Unauthorized' }), 'Unauthorized', undefined],
    ['the role does not mail this kind', refused(403, { message: 'Forbidden' }), 'Forbidden', undefined],
    ['the organization is not written here', refused(409, { code: 'org_home_elsewhere', message: 'Read-only here' }), 'Read-only here', undefined],
  ] as const) {
    it(`${name}: the rest is not asked, and the server's words are shown`, async () => {
      const s = server(three(), (_body, nth) => (nth === 0 ? error : undefined))
      const d = dialog(s)
      await d.open(['a1', 'b1', 'c1'])

      const outcome = await d.send()

      expect(s.mailRequests()).toHaveLength(1)
      expect(d.halted.value).toBe(true)
      expect(d.stopped.value).toBe(words)
      expect(d.results.value.map(r => [r.to, r.results.map(x => [x.id, x.status, x.message, x.reason])])).toEqual([
        ['one@buyer.test', [['a1', 'failed', words, reason]]],
        // Never asked: neither a reason nor the server's words, only that they did not go.
        ['two@buyer.test', [['b1', 'skipped', undefined, undefined]]],
        ['three@buyer.test', [['c1', 'skipped', undefined, undefined]]],
      ])
      expect({ ...d.progress }).toEqual({ done: 3, total: 3 })
      // Nothing leaves the selection.
      expect(outcome).toEqual({ went: [], documents: 0, recipients: 0, queued: false, allFine: false })
    })
  }

  for (const [name, error] of [
    ['a busy gateway', refused(503, { message: 'Service Unavailable' })],
    ['a server error', refused(500, { message: 'Internal Server Error' })],
    ['one recipient refused', refused(400, { message: 'A valid recipient email is required' })],
    ['no answer at all', new Error('Network Error')],
  ] as const) {
    it(`${name} is that recipient's alone: the others are still asked`, async () => {
      const s = server(three(), (_body, nth) => (nth === 0 ? error : undefined))
      const d = dialog(s)
      await d.open(['a1', 'b1', 'c1'])

      const outcome = await d.send()

      expect(s.mailRequests().map(m => m.body.to)).toEqual(['one@buyer.test', 'two@buyer.test', 'three@buyer.test'])
      expect(d.halted.value).toBe(false)
      expect(d.results.value[0]!.results.map(r => [r.status, r.message])).toEqual([['failed', (error as any).response?.data?.message ?? 'Network Error']])
      expect(outcome).toEqual({ went: ['b1', 'c1'], documents: 2, recipients: 2, queued: false, allFine: false })
    })
  }

  it('is told apart by status and code', () => {
    expect(stopsTheBatch(refused(401))).toBe(true)
    expect(stopsTheBatch(refused(403))).toBe(true)
    expect(stopsTheBatch(refused(409))).toBe(true)
    expect(stopsTheBatch(refused(503, { code: 'not_configured' }))).toBe(true)
    expect(stopsTheBatch(refused(503))).toBe(false)
    expect(stopsTheBatch(refused(422, { code: 'selection_too_large' }))).toBe(false)
    expect(stopsTheBatch(refused(502))).toBe(false)
    expect(stopsTheBatch(new Error('Network Error'))).toBe(false)
    expect(stopsTheBatch(undefined)).toBe(false)
  })
})

describe('the one address, next time', () => {
  it('is remembered once a mail to it has gone, as it was typed without the spaces around it', async () => {
    const remembered = memory()
    const d = dialog(server([row('a1', { id: 'p1', email: 'one@buyer.test' })]), { remembered })
    await d.open(['a1'])
    d.mode.value = 'single'
    d.singleTo.value = ' accountant@office.test '
    await d.send()
    expect(remembered.value).toBe('accountant@office.test')
  })

  it('is not remembered when nothing went to it: a typo that bounced is not where the field should start', async () => {
    const remembered = memory('accountant@office.test')
    const s = server([row('a1', { id: 'p1', email: 'one@buyer.test' })], body => ({
      to: body.to, mails: 0, queued: false, results: [{ id: 'a1', number: 'DOC-a1', status: 'failed', reason: 'provider_error' }],
    }))
    const d = dialog(s, { remembered })
    await d.open(['a1'])
    d.mode.value = 'single'
    d.singleTo.value = 'acountant@ofice.test'
    await d.send()
    expect(remembered.value).toBe('accountant@office.test')
  })

  it('is kept per kind, user and organization, where every other preference is', () => {
    const src = readFileSync(join(import.meta.dir, '..', '..', '..', 'ui-shared', 'src', 'composables', 'useBatchEmail.ts'), 'utf8')
    expect(src).toContain('rememberedSetting<string>(`doc-email-to-${options.kind()}`)')
  })
})

describe('a run of document numbers', () => {
  const numbers = (n: number) => Array.from({ length: n }, (_, i) => `DOC-${i + 1}`)

  it('is shown whole while it is short', () => {
    expect(shortList([])).toEqual({ shown: [], more: 0 })
    expect(shortList(numbers(1))).toEqual({ shown: ['DOC-1'], more: 0 })
    expect(shortList(numbers(6))).toEqual({ shown: numbers(6), more: 0 })
  })

  it('is cut to its first ones, and says how many more there are', () => {
    // Never "and 1 more": the cut leaves room for the count, so seven are five and two more.
    expect(shortList(numbers(7))).toEqual({ shown: numbers(5), more: 2 })
    expect(shortList(numbers(100))).toEqual({ shown: numbers(5), more: 95 })
    expect(shortList(numbers(4), 3)).toEqual({ shown: numbers(2), more: 2 })
  })
})

describe('the dialog\'s words', () => {
  const LOCALES = ['en', 'bg', 'de', 'mk'] as const
  const catalogue = (locale: string) =>
    JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'ui-shared', 'src', 'locales', `${locale}.json`), 'utf8')).docEmail

  it('name every reason a document does not go: the dialog looks them up by the server\'s own names', () => {
    // A key built at run time is out of reach of `web-catalogue-i18n.test.ts`; a reason without one would read as its code.
    for (const locale of LOCALES) {
      const reasons = catalogue(locale).reason
      for (const reason of [...DOC_EMAIL_SKIPS, ...DOC_EMAIL_FAILURES, 'notAsked']) {
        expect({ locale, reason, text: typeof reasons[reason] === 'string' && reasons[reason].length > 0 }).toEqual({ locale, reason, text: true })
      }
    }
  })

  it('count documents and recipients in both numbers, in every language', () => {
    for (const locale of LOCALES) {
      for (const key of ['intro', 'nDocuments', 'nRecipients']) {
        expect({ locale, key, forms: String(catalogue(locale)[key]).split(' | ').length }).toEqual({ locale, key, forms: 2 })
      }
    }
  })

  it('never use a character the message format reads as its own', () => {
    // `@` starts a linked message in vue-i18n: an address written into a text would be read as a key.
    for (const locale of LOCALES) {
      const flat = JSON.stringify(catalogue(locale))
      expect({ locale, at: flat.includes('@') }).toEqual({ locale, at: false })
    }
  })
})
