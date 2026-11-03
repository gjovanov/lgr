/**
 * FR-25 §7.4: what an ЕГН says by itself. Import-pure.
 *
 * The month carries the century: +20 for the 1800s, +40 for the 2000s. Which pension rate applies
 * follows from the year of birth, so a person with no ЕГН needs their date of birth on the record.
 */
const WEIGHTS = [2, 4, 8, 5, 10, 9, 7, 3, 6]

export function egnChecksumHolds(egn: string): boolean {
  if (!/^\d{10}$/.test(egn)) return false
  const sum = WEIGHTS.reduce((total, weight, i) => total + weight * Number(egn[i]), 0)
  return (sum % 11) % 10 === Number(egn[9])
}

/** `YYYY-MM-DD`, or null when these ten digits do not name a date. Fixtures use month 13 on purpose. */
export function birthDateOfEgn(egn: string): string | null {
  if (!/^\d{10}$/.test(egn)) return null
  const yy = Number(egn.slice(0, 2))
  const mm = Number(egn.slice(2, 4))
  const dd = Number(egn.slice(4, 6))
  const century = mm >= 41 && mm <= 52 ? 2000 : mm >= 21 && mm <= 32 ? 1800 : mm >= 1 && mm <= 12 ? 1900 : null
  if (century === null) return null
  const year = century + yy
  const month = century === 2000 ? mm - 40 : century === 1800 ? mm - 20 : mm
  const date = new Date(Date.UTC(year, month - 1, dd))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== dd) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

/** Birth year below 1960: the higher pension rate and no universal fund (КСО чл. 157). */
export const bornBefore1960 = (birthDate: string): boolean => Number(birthDate.slice(0, 4)) < 1960
