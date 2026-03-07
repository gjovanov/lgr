# Desktop Installation Guide

## Download

Download the latest installer from [GitHub Releases](https://github.com/gjovanov/lgr/releases?q=desktop).

| Platform | File | Notes |
|----------|------|-------|
| Windows | `LGR-Desktop_x.x.x_x64-setup.exe` | NSIS installer, Windows 10+ |
| macOS (Apple Silicon) | `LGR-Desktop_x.x.x_aarch64.dmg` | M1/M2/M3 Macs |
| macOS (Intel) | `LGR-Desktop_x.x.x_x64.dmg` | Intel Macs |
| Linux (Debian/Ubuntu) | `lgr-desktop_x.x.x_amd64.deb` | `sudo dpkg -i <file>` |
| Linux (AppImage) | `LGR-Desktop_x.x.x_amd64.AppImage` | `chmod +x <file> && ./<file>` |

### Prerequisite: Bun Runtime

LGR Desktop requires the [Bun](https://bun.sh) JavaScript runtime to be installed on your system:

```bash
# Linux / macOS
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
irm bun.sh/install.ps1 | iex
```

Verify with `bun --version` (v1.1+ required).

## Install

### Windows
1. Download the `.exe` installer
2. Run it — Windows SmartScreen may warn (click "More info" > "Run anyway")
3. LGR Desktop appears in Start Menu

### macOS
1. Download the `.dmg` for your architecture
2. Open the DMG and drag LGR Desktop to Applications
3. First launch: right-click > Open (macOS may block unsigned apps)

### Linux (Debian/Ubuntu)
```bash
sudo dpkg -i lgr-desktop_*.deb
```

### Linux (AppImage)
```bash
chmod +x LGR-Desktop_*.AppImage
./LGR-Desktop_*.AppImage
```

## First Launch

1. Open LGR Desktop
2. The app creates a default organization and admin user:
   - Organization: `My Company` (slug: `my-company`)
   - Username: `admin`
   - Password: `admin123`
3. Log in with these credentials
4. **Change the admin password** in Settings

## Data Location

All data is stored locally in a single SQLite database file:

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\com.lgr.desktop\lgr.db` |
| macOS | `~/Library/Application Support/com.lgr.desktop/lgr.db` |
| Linux | `~/.local/share/com.lgr.desktop/lgr.db` |

Archives (automatic daily backups) are stored in an `archives/` subdirectory alongside the database.

## System Tray

LGR runs in the system tray. Closing the window minimizes to tray instead of quitting. Use the tray menu to:
- **Show** — Bring the window back
- **Quit** — Stop the API and exit

## Uninstall

### Windows
Control Panel > Programs > Uninstall "LGR Desktop"

### macOS
Drag LGR Desktop from Applications to Trash

### Linux
```bash
sudo dpkg -r lgr-desktop    # Debian
rm LGR-Desktop_*.AppImage   # AppImage
```

Your data in the [data location](#data-location) is preserved after uninstall. Delete it manually if no longer needed.

## Building from Source

### Prerequisites

- [Bun](https://bun.sh) v1.1+
- [Rust](https://rustup.rs) toolchain (`rustup`)
- Platform-specific build dependencies (Linux only):

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libcairo2-dev \
  libglib2.0-dev libpango1.0-dev libatk1.0-dev \
  libgdk-pixbuf-2.0-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev libappindicator3-dev \
  librsvg2-dev patchelf
```

### Build

```bash
git clone https://github.com/gjovanov/lgr.git
cd lgr
bun install
bun run build:desktop-ui   # Build the frontend
bun run tauri:build         # Build the Tauri app
```

The installer will be in `packages/desktop/src-tauri/target/release/bundle/`.

### Development

```bash
bun run dev:desktop         # API + UI (hot reload)
bun run tauri:dev           # Full Tauri dev mode (native window)
```

## Releasing

Releases are built automatically by GitHub Actions. To create a new release:

### Option A: Git tag (automated)
```bash
git tag desktop-v0.2.0
git push origin desktop-v0.2.0
```
This triggers the CI pipeline which builds for all platforms and creates a GitHub Release.

### Option B: Manual dispatch
Go to Actions > "Desktop Release" > Run workflow. Enter the version number and optionally create as draft.

The workflow builds on:
- Ubuntu 22.04 (Linux amd64: `.deb`, `.AppImage`)
- macOS latest (Apple Silicon: `.dmg`)
- macOS 13 (Intel: `.dmg`)
- Windows latest (x64: `.exe`, `.msi`)
