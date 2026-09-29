# Signing LGR Desktop

Every LGR Desktop artifact is signed with **roomler's signing identity**. Nothing is enrolled with
Microsoft, Apple or a key server for LGR — it reuses exactly what signs roomler today (FR-14.3).

⚠ **Two repositories now hold copies of one identity.** `gjovanov/*` is a personal account, so
there are no org-level secrets to share. See [Rotation](#rotation) — getting this wrong breaks
releases in the *other* repo, and the symptom appears at tag time.

## The three identities

| Platform | Identity | Produced by |
|---|---|---|
| Windows | Azure Artifact Signing, publisher subject **`G ROX LTD`** | `gjovanov/roomler-ai/.github/actions/sign-windows`, pinned to a SHA |
| macOS | `Developer ID Application: G ROX EOOD (4TG7586MY5)`, valid to 2031-09-09, + an App Store Connect API key for notarisation | Tauri's bundler, fed the same credentials |
| Linux | roomler's release GPG key `D654B016256FD92A81634A0E2AD1E9F025973A7F` (signing subkey `…A2C53E5FE6FA485A`) | `gpg --detach-sign` per package |

All three also get **SLSA build provenance** (`actions/attest-build-provenance`), attested *after*
signing so the statement describes the bytes that ship.

## Where it lives

- GitHub **environment `release`** in `gjovanov/lgr` — holds the 8 secrets (5 Apple, 3 GPG).
- **Repository variables** — the 7 `AZURE_*` values. Not secrets: they name an endpoint, an
  account, a profile and three Azure ids. The credential itself is the OIDC exchange.
- **Entra federated credential** `lgr-github-environment` on the app registration
  `roomler-ai-github-signing`, subject `repo:gjovanov/lgr:environment:release`.

⚠ **Every job that signs must declare `environment: release`.** The federated credential is bound
to an *environment* — roomler's tenant rejects wildcard tag subjects — so a job without that line
fails the OIDC exchange with an error that reads like a signing outage rather than a missing line.
Windows jobs additionally need `id-token: write`.

## Windows: why the build runs twice

FR-14.3 requires **every PE** to be signed, and an installer is built by copying the application
executable into itself. Signing only the installers would leave an unsigned `LGR Desktop.exe` on
every machine that installs one — and that inner exe is what SmartScreen and AppLocker judge when
the app is launched.

Tauri's `bundle.windows.signCommand` would be the tidy way to do this, but roomler's signer is a
**composite action, not a CLI**, so it cannot be called from inside the bundler. So:

1. `cargo tauri build --no-bundle` → the app exe
2. sign it
3. `cargo tauri build --bundles nsis,msi` → installers, built around the signed exe
4. **assert the exe is still signed**
5. sign the installers

⚠ Step 4 is load-bearing. Cargo fingerprints its *inputs*, so an unchanged second invocation
reports the binary fresh and leaves it alone, signature included. If that ever stops holding, cargo
relinks, the signature is silently gone, and the installers would ship an unsigned exe while every
later check still passed.

## macOS: the check that matters

`codesign --verify` passes on an app that is **signed but not notarised**, and such an app is
refused on every customer Mac with a dialog offering no way forward. Only Gatekeeper's own verdict
distinguishes them, so the pipeline greps for it:

```
spctl --assess --type execute --verbose=4 "LGR Desktop.app"   # → source=Notarized Developer ID
```

## Proving it works: `signing-smoke.yml`

A manual workflow that signs **throwaway** artifacts on all three platforms — a generated PE, a
generated `.app`, a text file — and verifies each as a user would. It is the cheapest way to answer
"is the signing material still good?" without cutting a release.

```bash
gh workflow run signing-smoke.yml --repo gjovanov/lgr
```

⚠ lgr is private: macOS minutes bill at 10× and Windows at 2×, and notarisation alone takes
minutes. Untick the platforms you do not need.

First proven end to end in run
[36538198352](https://github.com/gjovanov/lgr/actions/runs/36538198352): a PE `Valid` with
`CN=G ROX LTD` and a Microsoft RFC3161 timestamp, an `.app` notarised `Accepted` and stapled with
Gatekeeper reporting `source=Notarized Developer ID`, and a detached `.asc` verifying in a clean
keyring holding only roomler's published key.

## Rotation

⚠ **A rotation done in only one repository breaks the other one's releases.** Rotate both the same
day.

roomler's `60-apple-setup.sh` and `70-gpg-release-key.sh` write **only** roomler-ai's repo-level
secrets. The same values then have to be copied here:

```bash
gh secret set APPLE_DEVELOPER_ID_APP_P12_BASE64 --repo gjovanov/lgr --env release < …
# …and APPLE_CERT_PASSWORD, APPLE_API_KEY_ID, APPLE_API_ISSUER_ID, APPLE_API_KEY_P8_BASE64,
#     GPG_PRIVATE_KEY, GPG_PASSPHRASE, GPG_KEY_ID
gh workflow run signing-smoke.yml --repo gjovanov/lgr     # then prove it
```

Two checks catch a missed rotation at release time rather than at a customer's install: the
`expect-subject-contains` check inside `sign-windows`, and the updater's pinned fingerprints
(FR-14.28).

## ⚠ Still to do: the updater's minisign key

**This is an ops step nobody has done yet, and the updater (FR-14.28 / C13) cannot ship without
it.** Tauri's updater has its own signature, separate from the platform signatures above: two
signatures must pass before an update is applied.

```bash
# once, on a trusted machine
bunx @tauri-apps/cli signer generate -w ~/.tauri/lgr-desktop-updater.key

# the PRIVATE half -> the release environment, beside roomler's signing material
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo gjovanov/lgr --env release \
  < ~/.tauri/lgr-desktop-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo gjovanov/lgr --env release
```

The **public** half is pinned in `tauri.conf.json` under `plugins.updater.pubkey` by C13 — it is
not a secret, and it must be in the binary for the pin to mean anything.

⚠ Losing the private key means **no installed desktop can ever be updated again**: the pinned
public key is baked into every shipped binary, so a new keypair orphans the entire fleet. Back it
up wherever roomler's signing material is backed up.
