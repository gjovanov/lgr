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

> **Status (2026-10-05, multi-org sign-in Phase 1):** the model and the migration exist; nothing
> reads identities yet. Sign-in still authenticates the per-org `User`. Phase 2 moves login, org
> switching and OAuth onto the identity.

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
