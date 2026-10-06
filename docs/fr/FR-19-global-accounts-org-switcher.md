# FR-19 — One account per person, org-less sign-in, and an org switcher

**Status (2026-10-06):** Phases 0–2 and the Phase 4 backend shipped (Release A, Release B,
`v20261006-e9b3f57211ec`), and production was migrated (`idmig-2026-10-06T08-07-35-529Z`).
Phase 3 and the Phase 4 UI are Release C.
Model page: [`docs/models/core/identity.md`](../models/core/identity.md).

## Why

The same people work in several orgs (`regal`, `regal-pz`, `regal-sf`). Each org held its own
`User` for them, often under a different username, and reaching the other org meant signing out
and in again with that org's slug. An org admin was the effective owner of a multi-org person's
password, because each org's copy of it was theirs to set.

## Decisions (2026-10-02)

1. **One global account per person.** An `Identity` holds the email, the password and the
   provider links. Each org's `User` is the person's membership there: role, permissions,
   operator code and username stay per org. Sessions stay ORG-SCOPED (`tokenize()` of one
   membership, plus `iid`/`tv`), so the tenant guard and every permission check are unchanged.
2. **Sign-in like roomler.ai:** "Username or email", a password, and provider buttons that need
   no org. The org field appears only when asked for, or when a username is ambiguous.
3. **An org menu in every app's top bar**, listing the person's orgs and invitations.
4. **Each browser tab keeps its own org**: two orgs side by side, and a switch never disturbs
   another tab (a POS till holding the fiscal printer, a half-filled form).
5. In scope: join an org while signed in, found an org from the menu, change your password,
   forgot-password by email.

## Rules the implementation holds

| # | Rule | Where |
|---|------|-------|
| 1 | At most one password verification per sign-in; a username several people share answers `409 ambiguous_login` | `services/biz/identity/session.service.ts` |
| 2 | An org admin never controls the credentials of someone active in another org (`identity_shared`), and never creates a user at an address that is already someone's (`identity_exists`: invite instead) | `identity.service.ts`, `user.controller.ts` |
| 3 | Joining or founding an org needs a credential the person owns (`own_password_required`) | `account.service.ts` |
| 4 | OAuth matches by email only when the provider verified it; a migrated link counts only when the provider vouches for the same address (`link_unconfirmed`) | `oauth.service.ts` |
| 5 | Never land in an org the person did not pick: this browser's last org, then theirs, then their only one, else the picker | `chooseLanding` |
| 6 | Per-tab sessions hold only because every token read goes through one module | `ui-shared/src/session/session.ts`, enforced by `unit/session-keys.test.ts` |
| 7 | A non-empty Bearer is used exclusively; switch, join, found and password change refuse a cookie alone | `session-token.ts`, `session-answer.ts` |

## What the UI does (Phase 3, Phase 4 UI)

- **Sign-in** (`portal-ui/views/auth/LoginView.vue`): username or email, password with show/hide,
  "Forgot password?", provider buttons from `GET /api/oauth/providers`, the org field behind a
  link. A sign-in with nothing to land in goes to the picker (`/orgs`), and a pending invitation
  goes to `/invite/:code`. OAuth refusals come back as `?error=<code>`, and only known codes are
  translated.
- **Org menu** (`ui-shell/OrgSwitcher.vue`): orgs with the role in each, invitations to join,
  New organization (`NewOrgDialog.vue`; the address is suggested from the name, Cyrillic
  transliterated), All organizations. A switch is `POST /auth/switch` and a full reload of THIS
  tab: the same page when it names nothing of the old org, else the app's home, else the App
  Hub when the app is not enabled for the person there.
- **Guards:** refused while the tab holds a sale in progress or a bridged fiscal printer;
  asks first over unsaved form edits, which stay under Pending changes in the org they belong to.
- **Per-tab sessions:** `sessionStorage` per tab; `localStorage` is only what a new tab starts
  in. A 401 signs out that tab only. Signing out signs out every tab of the same person.
- **Downloads** fetch with the tab's bearer token (`useSessionDownload.ts`), never a plain link:
  the `auth` cookie names the org this browser entered last, in any tab.
- **Account** (`/account`): profile, change password (ends every other session), the sign-in
  methods. A provider-only person sets a first password through the email link.
- **Forgot / reset** (`/auth/forgot-password`, `/auth/reset-password#token=…`).
- **Invitations:** a signed-in person joins with one click ("Join *org* as *email*").
- **Admin users screen:** a person who also works elsewhere has name, email and password locked
  (rule 2); creating a user at a taken address offers "Send an invitation instead".

## Not done (follow-ups)

- Linking and unlinking sign-in providers from the account page (needs a link-intent endpoint).
- Editing your own name from the account page.
- Leaving an org; changing an identity's email.
- Release D: removing the legacy `User.password` / `User.oauthProviders` copies, gated on a backup
  that covers `identities`.
- An org-scoping audit of the by-`_id` lookups in the remaining controllers.

## Field test (lgrai.app)

1. Goran signs in with Google, with no org: sees regal, regal-pz and regal-sf; switches.
2. Password sign-in by username and by email; an ambiguous username asks for the org.
3. A regal tab and a regal-pz tab side by side; a reload of either keeps its org; a POS tab with
   a sale in progress refuses a switch.
4. A files-ui download in each of the two tabs.
5. A Bulgarian forgot-password email arrives and the link sets a password.
6. An import skill still signs in with `--org regal-pz`.
