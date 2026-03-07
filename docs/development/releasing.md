# Release Process

## Cloud Release

1. Run all tests:
   ```bash
   bun run test          # Integration
   bun run test:e2e      # E2E
   ```

2. Build all UI packages:
   ```bash
   bun run build         # All 8 UIs
   ```

3. Deploy each API service (independently scalable)

4. Each API serves its pre-built UI as static files in production

## Desktop Release

### 1. Test

```bash
bun run test                                    # Integration
bun test packages/tests/src/dal/parity/         # DAL parity
```

### 2. Build Desktop UI

```bash
bun run build:desktop-ui
```

### 3. Build Tauri App

```bash
bun run tauri:build
```

This produces platform-specific installers in `packages/desktop/src-tauri/target/release/bundle/`:

| Platform | Output |
|----------|--------|
| Windows | `.msi`, `.exe` installer |
| macOS | `.dmg`, `.app` |
| Linux | `.deb`, `.AppImage` |

### 4. Code Signing (Production)

- **Windows**: Sign with a code signing certificate using `signtool`
- **macOS**: Sign with Apple Developer certificate, notarize with `xcrun notarytool`
- **Linux**: No signing required (but consider GPG-signing the package)

### 5. Auto-Updates

Tauri's built-in updater checks for new versions on startup. Configure the update endpoint in `tauri.conf.json`:

```json
{
  "plugins": {
    "updater": {
      "endpoints": ["https://releases.lgrai.app/desktop/{{target}}/{{arch}}/{{current_version}}"],
      "pubkey": "..."
    }
  }
}
```

## Version Numbering

Follow semver: `MAJOR.MINOR.PATCH`

- Bump in: `package.json` (root), `packages/desktop/src-tauri/Cargo.toml`, `packages/desktop/src-tauri/tauri.conf.json`
