import { sessionAuth } from './session-auth'

/**
 * Verification-only auth service for domain apps.
 * Validates JWT issued by Portal but does NOT issue tokens.
 *
 * FR-24.30: ONE copy, here. It used to exist byte-identical in all seven `*-api` packages, deduped
 * by Elysia's `name` so that whichever was registered first ran, and a fix to the tenant guard
 * had to land seven times. Each package's `auth/app-auth.service.ts` now re-exports this one.
 *
 * FR-32.25: the chain itself is `./session-auth.ts`, the one the portal's `AuthService` (`Service.Auth`) runs too.
 * The domain routes include no identity route, so this plugin admits no identity-only token.
 */
export const AppAuthService = sessionAuth({ name: 'Service.AppAuth', identityRoutes: false })
