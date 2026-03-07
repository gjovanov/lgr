# Desktop Installation Guide

## Download

Download the installer for your platform from the releases page:

| Platform | File |
|----------|------|
| Windows | `LGR-Desktop_x.x.x_x64-setup.exe` |
| macOS | `LGR-Desktop_x.x.x_universal.dmg` |
| Linux (Debian/Ubuntu) | `lgr-desktop_x.x.x_amd64.deb` |
| Linux (AppImage) | `LGR-Desktop_x.x.x_amd64.AppImage` |

## First Launch

1. Open LGR Desktop
2. The app creates a default organization and admin user:
   - Organization: `My Company` (slug: `my-company`)
   - Username: `admin`
   - Password: `admin123`
3. Log in with these credentials
4. **Change the admin password** in Settings

## Data Location

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\com.lgr.desktop\lgr.db` |
| macOS | `~/Library/Application Support/com.lgr.desktop/lgr.db` |
| Linux | `~/.local/share/com.lgr.desktop/lgr.db` |

## System Tray

LGR runs in the system tray. Closing the window minimizes to tray instead of quitting. Use the tray menu to:
- **Show** — Bring the window back
- **Quit** — Stop the API and exit

## Building from Source

### Prerequisites

- Bun v1.1+
- Rust toolchain (`rustup`)
- Platform-specific build dependencies:

**Linux:**
```bash
sudo apt-get install libwebkit2gtk-4.1-dev libcairo2-dev \
  libglib2.0-dev libpango1.0-dev libatk1.0-dev libgdk-pixbuf-2.0-dev \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
```

### Build

```bash
bun install
bun run build:desktop-ui   # Build the frontend
bun run tauri:build         # Build the Tauri app
```

The installer will be in `packages/desktop/src-tauri/target/release/bundle/`.

### Development

```bash
bun run dev:desktop         # API + UI (hot reload)
bun run tauri:dev           # Full Tauri dev mode
```
