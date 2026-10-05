# Identity

One person, across every org they work in. Each org's [User](user.md) document is that person's
**membership** in the org (role, permissions, operator code, per-org username); the identity holds
what belongs to the person: their email, password and sign-in providers.

Global: no `tenantPlugin`, no `orgId` (like `orgs` and `din_catalog`). Collection `identities`.

⚠ **It is not in any backup.** The per-org bundles take only collections with an `orgId` path
(`backup-bundle.service.ts#tenantCollections`), and a restore assumes global records already
exist, as it does for the `Org` document itself. Until the legacy `User.password` /
`User.oauthProviders` copies are removed, a restored `users` collection can still sign people in;
**removing those copies needs a backup that covers `identities` first.**

> **Status (2026-10-05, multi-org sign-in Phase 2):** every path that creates or edits a user keeps
> the identity in step (`services/biz/identity/identity.service.ts`), and sign-in is the person's:
> password and OAuth without an org, `GET /auth/orgs`, `POST /auth/switch`, revocation by
> `tokenVersion` (`services/biz/identity/session.service.ts`). Users the migration has not linked
> still sign in as before, so the code can ship ahead of `scripts/migrate-identities.ts --execute`.
> The UI (org switcher, per-tab sessions) is Phase 3.

## The person's own account (Phase 4)

| Endpoint | Who | Does |
|----------|-----|------|
| `POST /auth/password` | an org session or identity-only token (Bearer) | Change the password, proving the current one. Becomes `self`, bumps `tokenVersion`, mirrors the legacy copy; this tab gets a fresh token |
| `POST /auth/password/forgot` | anyone | Mails a reset link (60 min, single use). The same answer for any address; limited per address and per IP in counters of its own |
| `POST /auth/password/reset` | the link | Sets a `self` password, verifies the address, activates a waiting person and the memberships that waited, spends their other links |
| `POST /invite/:code/accept` | the signed-in person (Bearer) | Joins the invite's org with its role. Needs an own credential (rule 3) |
| `POST /auth/orgs` | the signed-in person (Bearer) | Founds an org with the person as admin. Needs an own credential (rule 3) |

Reset tokens live in `auth_tokens` (model `AuthToken`) as a SHA-256 only, so no database read can
reset anyone's password. The link carries the token in its fragment, which never reaches a server
or a log.

## Signing in

| Token | Carries | Reaches |
|-------|---------|---------|
| Org session | `tokenize()` of one membership, plus `iid` and `tv` when linked | Everything that membership's role and permissions allow, in its org |
| Identity-only | `{ type: 'identity', iid, tv, email }` | Only `services/biz/identity-routes.ts`: the person's orgs, and switching into one |

A token naming a person is live only while they are active and its `tv` equals their
`tokenVersion` (checked by all eight auth plugins, cached a minute per process). A password change
bumps it.

## Who may write what

| Path | Effect on the person |
|------|----------------------|
| Admin creates a user (`POST /org/:orgId/user`) | A new identity (`passwordSetBy: admin`). An address that is already someone's (an identity, or before the migration any user) is **409 `identity_exists`**: the person is invited instead |
| Admin edits password, email or names (`PUT`) | Applied to the identity and mirrored onto every membership, but only while the person has **no active membership in another org**; otherwise **403 `identity_shared`**. A password change bumps `tokenVersion`. Role, permissions, position and username stay per org |
| Self-registration (`POST /auth/register`) | A new identity, pending until the activation link verifies the address. An existing account is **409 `account_exists`** |
| OAuth sign-up | A new identity with a trusted provider link and no password. Refused at the callback when the provider did not verify the email (`unverified_email`) or the address has an account (`account_exists`) |
| OAuth join by invite | The provider account's owner (a migrated, unconfirmed link only if the provider vouches for the same address, else `link_unconfirmed`), the verified email's owner, or a new person. An unverified email never founds one. Before the migration, a person who still has unlinked users joins unlinked |
| OAuth sign-in by verified email | The provider is linked onto the identity too, which is how a migrated link becomes confirmed |

## Entity Interface

```typescript
type PasswordSetBy = 'self' | 'admin' | 'legacy'

interface IIdentityProvider {
  provider: string        // google | github | linkedin | facebook | microsoft
  providerId: string
  verified: boolean       // false for links carried over by the migration
  linkedAt: Date
}

interface IIdentity extends Document {
  _id: Types.ObjectId
  email: string           // lowercased, trimmed, unique
  emailVerified: boolean
  emailVerifiedAt?: Date
  password?: string       // argon2id, select: false
  passwordSetBy?: PasswordSetBy
  passwordSetByOrgId?: Types.ObjectId
  passwordChangedAt?: Date
  tokenVersion: number
  oauthProviders: IIdentityProvider[]
  firstName: string
  middleName?: string
  lastName: string
  avatar?: string
  isActive: boolean
  lastOrgId?: Types.ObjectId
  lastLoginAt?: Date
  migration?: { runId: string; sourceUserIds: Types.ObjectId[] }
  createdAt: Date
  updatedAt: Date
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Sign-in identifier and the password-reset channel. Lowercased and trimmed; **unique** |
| emailVerified | boolean | Yes | `false` | Set by a verified OAuth sign-in, activation or a password reset |
| password | string | No | - | argon2id (`Bun.password`). Never selected unless asked for (`+password`) |
| passwordSetBy | `self` \| `admin` \| `legacy` | No | - | Who chose it. `legacy` = carried over by the migration. Joining or creating another org needs `self` |
| passwordSetByOrgId | ObjectId | No | - | The org whose admin set it (`admin` only) |
| tokenVersion | number | Yes | `0` | Bumped on a password change or reset; sessions carrying an older value are revoked |
| oauthProviders | array | Yes | `[]` | Unique on `(provider, providerId)` across all identities |
| isActive | boolean | Yes | `true` | `false` only while a self-registration awaits activation. An admin deactivating someone acts on the **membership** (`User.isActive`), never here |
| lastOrgId | ObjectId | No | - | Where the person lands after signing in. Only their own sign-ins and switches change it |
| migration | object | No | - | Set by `scripts/migrate-identities.ts`; `--rollback <runId>` undoes exactly that run |

## Indexes

| Index | Why |
|-------|-----|
| `{ email: 1 }` unique | One identity per address |
| `{ 'oauthProviders.provider': 1, 'oauthProviders.providerId': 1 }` unique, partial on `providerId` existing | A provider account belongs to one person |
| `{ 'migration.runId': 1 }` sparse | Rollback by run |
| `User { identityId: 1, orgId: 1 }` unique, partial on `identityId` existing | One membership per person per org |

## Relationships

| Direction | Entity | Description |
|-----------|--------|-------------|
| hasMany | User | Memberships, one per org (`User.identityId`) |
| belongsTo | Org | `lastOrgId`, the landing preference (not a membership) |

## Migration

`scripts/migrate-identities.ts` creates an identity for every `User` that has none, grouping users
by normalised email. The rules, and why each exists, are in
`packages/services/src/biz/identity/identity-migration.service.ts`:

- A user alone at their email keeps their own password hash (`passwordSetBy: legacy`).
- Several users at one email become **one identity with no password**, unless the operator passes
  `--keep-password <email>=<org slug>`. An email is not proof of a person, so carrying a password an
  admin of another org may know would hand that admin the person's other orgs.
- OAuth links are copied `verified: false`; Microsoft links are dropped (on `/common` the email is
  settable by any tenant admin), and so is a provider account linked under two different emails.
- A merged identity gets no `lastOrgId`: its first sign-in shows the org picker.
- The dry run lists everyone it would leave with **no way to sign in** (no password, no link). Settle
  that list before `--execute`.

```bash
bun run scripts/migrate-identities.ts                       # dry run (default), emails masked
bun run scripts/migrate-identities.ts --report plan.json    # + the full plan, no password hashes
bun run scripts/migrate-identities.ts --execute --keep-password someone@example.com=regal-pz
bun run scripts/migrate-identities.ts --rollback idmig-2026-…
```

Against production, run it on master-node through a port-forward (deploy-prod skill, "Querying the
prod DB"), never inside the app container.
