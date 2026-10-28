/**
 * One definition of "the same address", for every identity path. Import-pure, so the identity
 * modules can share it without importing each other.
 */
export function normalizeEmail(email: string): string {
  return (email ?? '').trim().toLowerCase()
}
