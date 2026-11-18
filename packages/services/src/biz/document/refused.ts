/**
 * FR-32.21 (#797): how a document service says no. The invoice routes answered `status(code, body)`; the services
 * they call now return `refuse(code, body)` in the same place, and the route hands it back through `answered`. The
 * code and the body are the ones the route always sent, and what is not refused comes back as it was.
 *
 * A function that takes a `Status` works for both: a route passes Elysia's `status`, a service passes `refuse`.
 */
export type Status = (code: number, body: object) => any

/** A refusal on its way back to the route: the status and the body it answers with. */
export class Refused {
  constructor(readonly statusCode: number, readonly body: object) {}
}

export const refuse: Status = (code, body) => new Refused(code, body)

/** A service's answer as the route gives it: a refusal with its status, anything else as it is. */
export function answered(status: Status, out: unknown): any {
  return out instanceof Refused ? status(out.statusCode, out.body) : out
}
