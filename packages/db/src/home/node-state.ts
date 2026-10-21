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
 *
 * ⚠ A new FR-20 model that holds node state goes here. `backup-node-state.flow.test.ts` makes every
 * model with an `orgId` be classified as data, operational or node state, so a new one cannot land
 * without that choice.
 *
 * Import-pure (no models), so the classification can be read anywhere.
 */
export const NODE_STATE_MODELS: ReadonlySet<string> = new Set(['OrgHome', 'BackgroundTask'])
