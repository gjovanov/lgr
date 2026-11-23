import { sessionAuth } from 'services/http/session-auth'

/**
 * The portal's auth plugin, `Service.Auth`: the session chain of `services/http/session-auth.ts` (FR-32.25), with
 * the identity routes (`GET /auth/orgs`, `POST /auth/switch`) open to an identity-only token. The domain APIs run the
 * same chain as `AppAuthService` (`services/http/app-auth.service.ts`). Tokens are issued by the portal's
 * controllers, not here.
 */
export const AuthService = sessionAuth({ name: 'Service.Auth', identityRoutes: true })
