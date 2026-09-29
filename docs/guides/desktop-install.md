# Installing LGR Desktop

**Status:** the installable server-mode client is being built (FR-14). This guide covers what
exists today and is updated as each chunk lands.

Specification: [`docs/fr/FR-14-lgr-desktop-app-server-mode.md`](../fr/FR-14-lgr-desktop-app-server-mode.md)
· Architecture: [`docs/architecture/desktop.md`](../architecture/desktop.md)

## ⚠ Do not install `desktop-v0.1.x`

Releases `desktop-v0.1.1`–`0.1.3` (2026-03-14) are the **offline-first prototype** and have been
withdrawn in substance. They shipped a local database with a **built-in `admin` account whose
password was published in the release notes**, and they signed their local tokens with a secret
committed to this repository. If one is installed anywhere, uninstall it; its data was never part
of any LGR org.

The first FR-14 release sets `DESKTOP_MIN_VERSION` above them, so a v0.1.x build cannot talk to the
new endpoints either.

## What the client will need

- **A reachable LGR server.** There is no local mode and no offline work — the desktop opens your
  cloud app. That is by design, not a limitation to be worked around.
- **An LGR account.** The desktop has no accounts of its own; you sign in inside its window with
  your normal LGR login, exactly as in a browser.
- **A registration code** from an admin (Settings → Desktops), which makes the machine a known,
  revocable desktop of your org.

## Installers (FR-14.4)

| Platform | Artifact | Notes |
|---|---|---|
| Windows | per-user **NSIS** installer | for a user without admin rights; it updates itself |
| Windows | per-machine **MSI** | for AppLocker/WDAC-managed machines, deployed by IT; updates are IT-managed, and the app never elevates |
| macOS | **DMG** (arm64 and x64) | signed with a Developer ID, notarised and stapled |
| Linux | **`.deb`** and **`.rpm`** | each with a detached `.asc` signature |

⚠ Under AppLocker's default rules, executables in user-writable paths such as `%LOCALAPPDATA%` are
blocked, so the **per-user installer is refused by policy** on those machines. That is expected —
IT deploys the MSI instead.

Every artifact is signed. On Windows, SmartScreen shows the publisher **G ROX LTD**.

## Building it yourself

```bash
bun install
bun run build:desktop-ui          # the shell's pages
bun run tauri:dev                 # run the shell
bun run tauri:build               # produce an unsigned local build
```

Signing happens only in CI, on a `desktop-v*` tag.

## Uninstalling

Removes the app, the desktop key and the settings. If it can reach the server it offers to
unregister the desktop; otherwise an admin revokes it from Settings → Desktops. There is no local
data to keep or lose.
