/**
 * What a save of Settings → Organization sends (`PUT /org/:orgId`), and how its VAT rows hold the org's default rate.
 *
 * The route writes each value sent to its own path and keeps what a save does not name (#815). So the page sends what
 * a person can change on it, and sends a change as a change (#816):
 *
 * - **The default VAT rate** (`settings.taxConfig.defaultVatRate`, what a new document line starts from) is the rate
 *   of the one row ticked Default. The stored rows hold a name and a rate only, so the tick is not a row's: on load
 *   it goes on the first row whose rate is the stored default, and at most one row holds it. No row ticked sends no
 *   default, and the stored one stays.
 * - **A company field emptied** (tax number, VAT number, email, phone, website) is sent as `''`, which the route reads
 *   as "remove it". Left out, it kept the stored value.
 * - **An empty list of addresses or bank accounts** is sent as `[]`. Left out, the last row removed came back.
 * - **Nothing the page does not show**: no module list (the App Hub decides which apps an org has) and no payroll
 *   block (nothing reads the pay cycle, and the Bulgarian payroll has settings of its own).
 *
 * Import-pure: `unit/org-save-payload.test.ts` holds it.
 */

export interface VatRateRow {
  name: string
  /** A number, or `''` while the field is emptied (`v-model.number`). */
  rate: number | string
  /** Whether this row is the org's default rate. The page's own: never sent, never stored. */
  default?: boolean
}

export interface OrgAddressRow {
  type: string
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
  isDefault?: boolean
}

export interface OrgBankRow {
  bankName: string
  accountNumber?: string
  iban?: string
  swift?: string
  currency?: string
  isDefault?: boolean
}

/** The part of the page's form a save reads. */
export interface OrgSaveForm {
  name: string
  description: string
  taxNumber: string
  vatNumber: string
  email: string
  phone: string
  website: string
  representative: string
  placeOfIssue: string
  activityCode: string
  addresses: OrgAddressRow[]
  bankDetails: OrgBankRow[]
  baseCurrency: string
  defaultLocale: string
  vatEnabled: boolean
  vatRates: VatRateRow[]
  defaultCostingMethod: string
  allowNegativeStock: boolean
  cashRegister: Record<string, unknown>
  requireConnectedDevice: boolean
  digestEnabled: boolean
  digestHour: number
  digestLocale: string
  digestRecipients: string[]
  digestSections: Record<string, boolean>
}

const isRate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The rows as loaded, each a copy, with the Default tick on the first row whose rate is the stored default. */
export function vatRowsOf(stored: ReadonlyArray<{ name?: string; rate?: number }> | null | undefined, defaultVatRate: unknown): VatRateRow[] {
  const rows: VatRateRow[] = (stored ?? []).map(r => ({ name: r.name ?? '', rate: r.rate ?? 0, default: false }))
  const i = isRate(defaultVatRate) ? rows.findIndex(r => r.rate === defaultVatRate) : -1
  if (i >= 0) rows[i].default = true
  return rows
}

/** Tick a row Default, which unticks every other; or untick it, which leaves none ticked. */
export function tickDefaultRate(rows: VatRateRow[], index: number, ticked: boolean): void {
  rows.forEach((row, i) => { row.default = ticked && i === index })
}

/** The tax block a save sends: the rows as they are stored (a name and a rate), and the ticked row's rate if any. */
export function taxConfigPayload(vatEnabled: boolean, rows: ReadonlyArray<VatRateRow>) {
  const ticked = rows.find(r => r.default)
  return {
    vatEnabled,
    vatRates: rows.map(r => ({ name: r.name, rate: r.rate })),
    ...(ticked && isRate(ticked.rate) ? { defaultVatRate: ticked.rate } : {}),
  }
}

/** The body of the save. */
export function orgSavePayload(form: OrgSaveForm) {
  return {
    name: form.name,
    description: form.description,
    // `''` removes one (the route unsets it); `|| undefined` kept a value the person had emptied.
    taxNumber: form.taxNumber,
    vatNumber: form.vatNumber,
    email: form.email,
    phone: form.phone,
    website: form.website,
    // FR-25a: `''` clears one (the server unsets it), trimmed.
    representative: form.representative.trim(),
    placeOfIssue: form.placeOfIssue.trim(),
    activityCode: form.activityCode.trim(),
    // An empty list is sent: it empties the stored one.
    addresses: form.addresses,
    bankDetails: form.bankDetails,
    settings: {
      baseCurrency: form.baseCurrency,
      locale: form.defaultLocale,
      taxConfig: taxConfigPayload(form.vatEnabled, form.vatRates),
      inventory: {
        defaultCostingMethod: form.defaultCostingMethod,
        allowNegativeStock: form.allowNegativeStock,
      },
      cashRegister: {
        ...form.cashRegister,
        requireConnectedDevice: form.requireConnectedDevice,
      },
      // FR-11.1 (#21). The route writes each value sent to its own path, so the sections this page has no
      // switch for (Backups, the server's own) stay as they are stored.
      dailyDigest: {
        enabled: form.digestEnabled,
        hour: form.digestHour,
        // `''` is "the org's language": sent, the route removes the digest's own. Left out, it would keep it.
        locale: form.digestLocale,
        recipients: form.digestRecipients.map(id => ({ userId: id })),
        sections: { ...form.digestSections },
      },
    },
  }
}
