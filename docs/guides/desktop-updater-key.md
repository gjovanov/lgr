# LGR Desktop — the updater signing key (FR-14.28)

LGR Desktop installs an update only when **both** of these accept the downloaded installer:

1. **minisign**, against the public key compiled into the binary from
   `packages/desktop/src-tauri/updater.pub`; the signature must also name the installer of the
   version being installed (`install.rs#signed_file_matches`);
2. **The platform's own signature**:
   - Windows: **Authenticode**, with a valid chain and the publisher `CN=G ROX LTD` (roomler's
     Azure Trusted Signing, already in `desktop-release.yml`);
   - macOS: **Developer ID**: `codesign --verify --deep --strict`, Team ID `4TG7586MY5`
     (`Developer ID Application: G ROX EOOD`), and Gatekeeper's `source=Notarized Developer ID`.

This page is about (1). Until it is done, `updater.pub` is empty, every desktop reports
`updater_not_configured`, and **every release fails** at "Sign the per-user installer for the
updater", on purpose: a release without a `.sig` can never be installed automatically.

## One-time setup

Do this on your own machine. **Never paste the private key or its password into a chat, an issue or
a commit.**

```powershell
# 1. Generate the pair. Pick a strong password and keep it in your password manager.
cargo tauri signer generate -w "$HOME\.tauri\lgr-updater.key"
#    -> $HOME\.tauri\lgr-updater.key      PRIVATE (encrypted with the password)
#    -> $HOME\.tauri\lgr-updater.key.pub  public

# 2. Put both secrets in the `release` environment (the build job runs there).
#    (piped, not `<`: PowerShell has no input redirection; and never `--body`, which puts the key
#    on the command line and in history)
Get-Content -Raw "$HOME\.tauri\lgr-updater.key" | gh secret set TAURI_SIGNING_PRIVATE_KEY --env release --repo gjovanov/lgr
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release --repo gjovanov/lgr
#    (the second command prompts for the password, so it never lands in shell history)

# 3. Commit the PUBLIC key. Exactly the file's content, one line, no newline needed.
Copy-Item "$HOME\.tauri\lgr-updater.key.pub" packages\desktop\src-tauri\updater.pub
git add packages/desktop/src-tauri/updater.pub
git commit -m "chore(desktop): pin the updater's public key (FR-14.28)"
```

Back up the private key file and the password **separately** (e.g. the key in an offline vault,
the password in the password manager).

## How you know it worked

The next release proves it. The Windows build job runs

```
lgr-desktop.exe --verify-update <setup.exe> <setup.exe.sig> <version>
```

with the binary it has just built. That is the exact check a till runs (`install::verify_installer`),
so if `updater.pub` and the secret do not belong together, the release fails there with
`minisign_invalid`. It does not fail later on every till.

To check by hand on any Windows machine with a release downloaded:

```powershell
& "$env:LOCALAPPDATA\LGR Desktop\lgr-desktop.exe" --verify-update `
    .\LGR.Desktop_0.1.6_x64-setup.exe .\LGR.Desktop_0.1.6_x64-setup.exe.sig 0.1.6
# {"ok":true,"keyPinned":true,"detail":{"authenticode":"Valid","subject":"CN=G ROX LTD, ..."}}
```

## The first release with the updater is installed by hand

A desktop can only update itself once it RUNS a build with the updater and the key in it. So the
first such release (0.1.6 or later) is installed manually on every machine, from
`https://lgrai.app/api/desktop/download/<version>`. Every release after that installs itself.

## ⚠ Losing or rotating the key

- **Lost private key or password**: no installed desktop will ever accept another update. Recovery
  is a manual install of a build carrying a new `updater.pub`, on every machine.
- **Rotation** (e.g. suspected leak): ship ONE release signed with the OLD key whose binary carries
  the NEW `updater.pub`. Desktops install it with the old key, and from then on accept only the new
  one. Then replace the secrets. A leaked minisign key alone still installs nothing, because
  Authenticode (`G ROX LTD`) is checked too, but rotate anyway.

## What each platform gets

| Platform | Update file | Self-installs when |
|---|---|---|
| Windows | `LGR Desktop_<v>_x64-setup.exe` (+ `.sig`) | installed per-user (NSIS). The MSI is per-machine and never self-installs; IT deploys it. |
| macOS Apple Silicon | `LGR Desktop_<v>_aarch64.app.tar.gz` (+ `.sig`) | this user can write the `.app` **and** the folder it is in |
| macOS Intel | `LGR Desktop_<v>_x64.app.tar.gz` (+ `.sig`) | same |
| Linux | none | never: deb/rpm need elevation, and the shell never elevates |

⚠ **macOS and "managed".** The updater plugin's answer to a `.app` it cannot move is an
administrator password prompt. The shell never elevates, so it checks write access first
(`update::detect_install_kind_here`). An admin account that dragged the app into `/Applications`
updates itself. A standard account under an admin-installed app reports "managed" and is updated
by whoever manages the Mac.

⚠ **macOS needs a full release** (`platforms: all`, or a tag): a `windows-linux` dispatch builds no
Mac archive, so the hub offers Macs nothing for that version.

## What is not covered yet
- **Crash-loop rollback**: the state is recorded (`update.rs#UpdateState`) and logged, but nothing
  reinstalls the last known good version yet.
