import { config } from 'config'
import { logger } from '../logger/logger.js'

export interface CompanyInfo {
  companyName: string
  taxNumber: string
  vatNumber: string
  address?: {
    street: string
    city: string
    postalCode: string
    country: string
  }
  founders?: string[]
  owners?: string[]
  isValid: boolean
}

const EMPTY: CompanyInfo = { companyName: '', taxNumber: '', vatNumber: '', isValid: false }

// Map country prefix to verifyvat.com type ID
const VAT_TYPE_MAP: Record<string, string> = {
  AT: 'at_vat', BE: 'be_vat', BG: 'bg_vat', CY: 'cy_vat', CZ: 'cz_vat',
  DE: 'de_vat', DK: 'dk_vat', EE: 'ee_vat', EL: 'gr_vat', ES: 'es_vat',
  FI: 'fi_vat', FR: 'fr_vat', HR: 'hr_vat', HU: 'hu_vat', IE: 'ie_vat',
  IT: 'it_vat', LT: 'lt_vat', LU: 'lu_vat', LV: 'lv_vat', MT: 'mt_vat',
  NL: 'nl_vat', PL: 'pl_vat', PT: 'pt_vat', RO: 'ro_vat', SE: 'se_vat',
  SI: 'si_vat', SK: 'sk_vat', GB: 'gb_vat', XI: 'xi_vat',
}

const EU_PREFIXES = Object.keys(VAT_TYPE_MAP)

function detectCountryPrefix(value: string): { prefix: string; number: string } | null {
  const upper = value.trim().toUpperCase()
  for (const p of EU_PREFIXES) {
    if (upper.startsWith(p)) return { prefix: p, number: upper.slice(p.length) }
  }
  return null
}

// ----- Bulgaria adapter: eik.bg -----
export async function lookupBulgaria(eik: string): Promise<CompanyInfo> {
  const cleaned = eik.replace(/\D/g, '')
  if (!cleaned || cleaned.length < 9 || cleaned.length > 13) return { ...EMPTY }

  try {
    const resp = await fetch(`https://eik.bg/eik/${cleaned}`, {
      headers: { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': 'LGR-ERP/1.0' },
    })
    if (!resp.ok) return { ...EMPTY }

    const html = await resp.text()

    // Extract company name from <h1> or title-like element
    const nameMatch = html.match(/<h1[^>]*class="[^"]*name[^"]*"[^>]*>([^<]+)</)
      || html.match(/<h1[^>]*>([^<]+)</)
      || html.match(/<title>([^<]+?)[\s–-]+eik\.bg/i)
    const companyName = nameMatch ? nameMatch[1].trim() : ''

    // Extract address from address-related sections
    // eik.bg format: <strong>Седалище адрес:</strong> БЪЛГАРИЯ, Пазарджик, гр. Пазарджик, ПК 4400, ул. ПЛОВДИВСКА, № 110
    const addrMatch = html.match(/Седалище\s+адрес:<\/strong>\s*([^<]+)/i)
      || html.match(/(?:Адрес|Седалище)[^:]*:<\/strong>\s*([^<]+)/i)
      || html.match(/(?:Адрес|Седалище)[^:]*:\s*([^<]+)/i)
      || html.match(/<span[^>]*class="[^"]*address[^"]*"[^>]*>([^<]+)</)
    const rawAddr = addrMatch ? addrMatch[1].trim() : ''

    // Extract founders/owners
    const founders: string[] = []
    const foundersSection = html.match(/(?:Управител|Съдружници?|Представляващ)[^:]*:?\s*([^<]+)/gi)
    if (foundersSection) {
      for (const match of foundersSection) {
        const name = match.replace(/^[^:]+:\s*/, '').trim()
        if (name) founders.push(name)
      }
    }

    // Parse address parts (Bulgarian addresses)
    // Format: "БЪЛГАРИЯ, Пазарджик, гр. Пазарджик, ПК 4400, ул. ПЛОВДИВСКА, № 110"
    let address: CompanyInfo['address']
    if (rawAddr) {
      const parts = rawAddr.split(/[,;]/).map(s => s.trim()).filter(Boolean)

      // Extract postal code (ПК NNNN pattern)
      let postalCode = ''
      const pcIdx = parts.findIndex(p => /^ПК\s*\d+$/i.test(p))
      if (pcIdx >= 0) {
        postalCode = parts[pcIdx].replace(/^ПК\s*/i, '').trim()
        parts.splice(pcIdx, 1)
      }

      // Extract city (starts with "гр." or "с.")
      let city = ''
      const cityIdx = parts.findIndex(p => /^(?:гр\.|с\.)\s/i.test(p))
      if (cityIdx >= 0) {
        city = parts[cityIdx].replace(/^(?:гр\.|с\.)\s*/i, '').trim()
        parts.splice(cityIdx, 1)
      }

      // Remove country name if first part is БЪЛГАРИЯ/Bulgaria
      if (parts.length && /^БЪЛГАРИЯ|^Bulgaria/i.test(parts[0])) {
        parts.shift()
      }

      // Remove oblast/region (second part before city, if not a street)
      // Remaining parts after country/city/postal removal are street components
      const streetParts = parts.filter(p => !city || p !== city)
      const street = streetParts.join(', ')

      // Fallback city from remaining parts if not found via "гр."
      if (!city && streetParts.length > 0) {
        city = streetParts[0]
      }

      address = {
        city,
        street,
        postalCode,
        country: 'BG',
      }
    }

    return {
      companyName,
      taxNumber: cleaned,
      vatNumber: `BG${cleaned}`,
      address,
      founders,
      owners: founders,
      isValid: !!companyName,
    }
  } catch (err) {
    logger.error('eik.bg lookup failed:', err)
    return { ...EMPTY }
  }
}

// ----- EU VAT adapter: verifyvat.com -----
export async function lookupEU(vatNumber: string): Promise<CompanyInfo> {
  const token = config.companyLookup.verifyVatToken
  if (!token) {
    logger.warn('VERIFYVAT_TOKEN not configured')
    return { ...EMPTY }
  }

  const cleaned = vatNumber.trim().toUpperCase().replace(/[\s.-]/g, '')
  const detected = detectCountryPrefix(cleaned)
  if (!detected) return { ...EMPTY }

  const vatType = VAT_TYPE_MAP[detected.prefix]
  if (!vatType) return { ...EMPTY }

  try {
    const resp = await fetch('https://api.verifyvat.com/v1/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,
      },
      body: JSON.stringify({ type: vatType, id: cleaned }),
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      logger.error(`verifyvat.com returned ${resp.status}: ${errText}`)
      return { ...EMPTY }
    }

    const data = await resp.json() as any
    if (!data.success) {
      logger.warn(`verifyvat.com lookup not successful: ${data.message || data.code}`)
      return { ...EMPTY }
    }

    const entity = data.data?.entity
    const process = data.data?.process
    const isConfirmed = process?.output?.outcome === 'confirmed'

    // Extract company name from entity.names array
    const names = entity?.names || []
    const legalName = names.find((n: any) => n.kind === 'legal')
    const companyName = legalName?.value || names[0]?.value || ''

    // Extract address from entity.addresses array
    let address: CompanyInfo['address']
    const addresses = entity?.addresses || []
    const legalAddr = addresses.find((a: any) => a.kind === 'legal') || addresses[0]
    if (legalAddr) {
      const comp = legalAddr.components || {}
      const normalized = legalAddr.normalized || {}
      const lines = normalized.lines || []

      // Try to parse from normalized lines
      const streetLine = lines[0] || legalAddr.value?.split(',')[0] || ''
      const cityLine = lines.length > 1 ? lines.slice(1, -1).join(', ') : ''
      // Extract postal code from city line (e.g., "AT-1020 Wien")
      const pcMatch = cityLine.match(/(?:[A-Z]{2}-)?(\d{4,6})\s+(.+)/)

      address = {
        street: comp.street || streetLine,
        city: comp.locality || (pcMatch ? pcMatch[2] : cityLine),
        postalCode: comp.postcode || (pcMatch ? pcMatch[1] : ''),
        country: comp.countryCode || detected.prefix,
      }
    }

    // When VAT is confirmed but no address returned (partial coverage), set country from prefix
    if (!address && isConfirmed) {
      address = {
        street: '',
        city: '',
        postalCode: '',
        country: detected.prefix,
      }
    }

    return {
      companyName,
      taxNumber: detected.number,
      vatNumber: cleaned,
      address,
      isValid: isConfirmed,
    }
  } catch (err) {
    logger.error('verifyvat.com lookup failed:', err)
    return { ...EMPTY }
  }
}

// ----- Main entry point -----
export async function lookupCompany(vatOrTaxNumber: string): Promise<CompanyInfo> {
  const value = vatOrTaxNumber.trim()
  if (!value) return { ...EMPTY }

  const detected = detectCountryPrefix(value)

  // If BG prefix, try Bulgaria adapter first
  if (detected?.prefix === 'BG') {
    const bgResult = await lookupBulgaria(detected.number)
    if (bgResult.isValid) return bgResult
    // Fallback to EU adapter
    return lookupEU(value)
  }

  // If any EU prefix, use EU adapter
  if (detected) {
    return lookupEU(value)
  }

  // No prefix — assume Bulgarian EIK (pure digits)
  if (/^\d{9,13}$/.test(value)) {
    const bgResult = await lookupBulgaria(value)
    if (bgResult.isValid) return bgResult
    // Also try as BG VAT
    return lookupEU(`BG${value}`)
  }

  // Unknown format — try EU adapter as-is
  return lookupEU(value)
}
