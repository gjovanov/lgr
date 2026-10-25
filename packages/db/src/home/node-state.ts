/**
 * FR-20 node state: rows that carry an `orgId` but describe a NODE's relation to the org, not the
 * org's data (FR-20.3, plan step P0b-10).
 *
 * An org's backup bundle is how its data moves between nodes (an org move restores a bundle on the
 * master), so a bundle must never carry these: restored on another node they would assert things
 * that are only true where they were written. The bundle leaves them out, and a restore skips them
 * even when an older bundle still has them.
 *
 * - `OrgHome`: who writes the org. A Replace restore must never rewrite where an org's home is.
 * - `BackgroundTask`: a job's `owner` names the process on the node that ran it (FR-20.23). On
 *   another node no such process exists, and the orphan reaper there would fail the task.
 * - `NodeEnrollmentCode`, `NodeEnrollmentKey`, `NodeEnrollmentKeyUse`: global's registration of
 *   masters (FR-20.2, P2-1). A master restoring the org's bundle has no use for global's codes, and
 *   global must keep writing them for an org whose home is a master.
 * - `OrgLicence`: a pilot licence a sys-admin issued (FR-20.55, P2-3b). Global's record of what it
 *   granted: restoring an old bundle must not rewrite it, and a master has no use for it.
 * - `Outbox`: a master's queued outbound work (FR-20.86, P2-6). Restored on another node, a queued
 *   mail would leave twice.
 * - `RelayReceipt`: global's record of what it relayed for a master (P2-6), its dedupe.
 * - `RelayJob`: a document a master asked global to read for it (P2-6b): global's job, never the
 *   org's data.
 * - `IdpCode`: a "Sign in with LGR" code a master redeems (FR-20.39, P2-4), 60 seconds long.
 * - `ReplJournal`, `ReplOrg`: a master's capture of its own writes (FR-20.61, P3-1b). Restored
 *   elsewhere, a journal would claim changes that node never made.
 * - `OnpremCredential`: a person's local password or PIN for an org's master, as global keeps it to
 *   deliver (FR-20.40, P2-4c). FR-20.21: no backup holds a local credential.
 *
 * ⚠ A new FR-20 model that holds node state goes here. `backup-node-state.flow.test.ts` makes every
 * model with an `orgId` be classified as data, operational or node state, so a new one cannot land
 * without that choice.
 *
 * Import-pure (no models), so the classification can be read anywhere.
 */
export const NODE_STATE_MODELS: ReadonlySet<string> = new Set([
  'OrgHome',
  'BackgroundTask',
  'NodeEnrollmentCode',
  'NodeEnrollmentKey',
  'NodeEnrollmentKeyUse',
  'OrgLicence',
  'Outbox',
  'RelayReceipt',
  'RelayJob',
  'IdpCode',
  'OnpremCredential',
  'ReplJournal',
  'ReplOrg',
])
