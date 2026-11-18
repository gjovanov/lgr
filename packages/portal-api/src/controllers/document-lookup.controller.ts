import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { lookupDocuments } from 'services/biz/document-lookup.service'
import { LOOKUP_MAX_LENGTH } from 'config/document-lookup'

/**
 * FR-31.22 (#796, slice B5): `GET /api/org/:orgId/lookup/documents?number=…`, the top bar's "jump to a document".
 *
 * A read that writes nothing. Its route rule is `self` (`route-permission.ts`, `config/access/routes.ts`): every
 * member may ask, and the service searches only the families whose page the caller may open, so a document the
 * caller may not read is never found (`services/biz/document-lookup.service.ts`).
 */
export const documentLookupController = new Elysia({ prefix: '/org/:orgId/lookup' }).use(AuthService).get(
  '/documents',
  async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    return lookupDocuments(orgId, user, query.number)
  },
  {
    isSignIn: true,
    query: t.Object({ number: t.Optional(t.String({ maxLength: LOOKUP_MAX_LENGTH * 4 })) }, { additionalProperties: true }),
  },
)
