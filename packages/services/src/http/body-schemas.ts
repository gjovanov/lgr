import { t } from 'elysia'

/**
 * FR-32.18 (#797): the body-schema fragments the controllers share.
 *
 * `AnObject`: an element of an array a route writes, when the element's fields are the model's to judge (a product's
 * price tiers, a movement's product updates). It refuses an element that is not an object, which `t.Any()` let through
 * to the model, and keeps every field: a schema is a whitelist (`CLAUDE.md`, "a route's body schema is a whitelist"),
 * so naming fields here would drop the ones it did not name. A value the model does not allow answers 422 with its
 * field (`spaErrorHandler`).
 */
export const AnObject = t.Object({}, { additionalProperties: true })
