import { FiscalDevice } from 'db/models'
import { homeScope } from 'db/home/home'

/**
 * At start, a device left `online` by the previous process is not connected to this one: mark it
 * `offline` until a bridge registers it again.
 *
 * ⚠ FR-20.5: only the devices of orgs whose home is here. On global this used to touch every org's
 * devices; once an org's home is a master, its tills belong to that master's process, not to
 * global's restart. Returns how many were reset.
 */
export async function resetStaleFiscalStatuses(): Promise<number> {
  const res = await FiscalDevice.updateMany({ status: 'online', ...(await homeScope()) }, { status: 'offline' }).exec()
  return res.modifiedCount
}
