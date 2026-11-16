import { can, type Grant } from 'config/access'

/**
 * FR-26.7: a session that writes movements without `movements.create` (a Seller, through `inventory.transfer`)
 * writes transfers and nothing else. `inventory.write` keeps every type; `admin` is refused nothing.
 *
 * One definition for whoever asks: the movement routes on every write (`movement.controller.ts#transferOnly`), and
 * the list's mail, which goes by what a session may work on (`movement-email-guards.ts`).
 *
 * Import-pure.
 */
export function writesTransfersOnly(grant: Grant | null | undefined): boolean {
  return !can(grant, 'movements.create')
}
