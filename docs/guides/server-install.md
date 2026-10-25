# Installing LGR Server

LGR Server is the on-premises master (FR-20): the API and its apps, its database (MongoDB 7.0),
the PDF renderer and the link to lgrai.app, run by one OS service. It is released from
`.github/workflows/server-release.yml` as `server-v<version>` on GitHub, as a preview until the
updater and the field lanes have run it.

| OS | Asset | Installs to | Data |
|---|---|---|---|
| Windows 10/11, Server 2019+, x64 | `lgr-server-<v>-x86_64-pc-windows-msvc.msi` | `C:\Program Files\LGR Server` | `C:\ProgramData\LGR` |
| Ubuntu 22.04+, Debian 12, x64 | `lgr-server_<v>_amd64.deb` | `/opt/lgr-server` | `/var/lib/lgr` |
| other Linux, x64 | `lgr-server-<v>-x86_64-unknown-linux-gnu.tar.gz` | where you unpack it | `/var/lib/lgr` |

Each asset has a `.sha256` and a `.asc`, and the release carries SLSA build provenance.

## Check what you downloaded

- **Windows:** the MSI and `lgr-server.exe` inside it are signed by **G ROX LTD** (roomler's
  identity). In PowerShell: `Get-AuthenticodeSignature .\lgr-server-<v>-x86_64-pc-windows-msvc.msi`
  says `Valid`, and its signer is `CN=G ROX LTD`.
- **Any asset:** the `.asc` verifies against roomler's release key:
  ```bash
  curl -fsSL https://github.com/gjovanov/roomler-ai/releases/latest/download/roomler-release-pubkey.asc | gpg --import
  gpg --verify lgr-server_<v>_amd64.deb.asc lgr-server_<v>_amd64.deb
  ```
- **Provenance:** `gh attestation verify <asset> --repo gjovanov/lgr`.

## Windows

```powershell
msiexec /i lgr-server-<v>-x86_64-pc-windows-msvc.msi
```

The MSI:
- registers the service **LGR Server** (`LGRServer`), automatic, as `NT SERVICE\LGRServer`, with
  restarts after 5, 30 and 60 seconds, and starts it;
- opens the firewall for `lgr-server.exe` on the Domain, Private and Public profiles, from the
  local subnet only (Windows marks a new network Public);
- refuses to downgrade. A newer MSI upgrades in place.

Uninstalling (Settings, or `msiexec /x`) removes the service and the files and **keeps the data**.

## Ubuntu and Debian

```bash
sudo apt install ./lgr-server_<v>_amd64.deb
sudo systemctl enable --now lgr-server
```

The package creates the `lgr` user and `/var/lib/lgr`, and installs the unit
`/usr/lib/systemd/system/lgr-server.service`. ⚠ It never starts, stops or restarts the service
itself, on install or on upgrade (roomler's rule), so an upgrade never interrupts a till in the
middle of a sale. Restart it when it suits the shop: `sudo systemctl restart lgr-server`.

## The tarball

Unpack it, then let the supervisor register itself with systemd:

```bash
sudo tar xzf lgr-server-<v>-x86_64-unknown-linux-gnu.tar.gz -C /opt
sudo mv /opt/lgr-server-<v>-x86_64-unknown-linux-gnu /opt/lgr-server
sudo /opt/lgr-server/lgr-server service install
```

Its `mongod` is MongoDB's Ubuntu 22.04 build: it needs glibc 2.35, OpenSSL 3 and libcurl.

## After installing

- `lgr-server status`: the supervisor, its children and its link.
- `lgr-server setup-token`: the link that opens the setup console.
- `lgr-server register --code XXXX-XXXX`: register with lgrai.app (the code comes from the org's
  Servers page).
- `lgr-server licence import <file>`: an air-gapped server's licence.

## What is inside

`HOME.json` says what the home is: its version, commit, target and the versions it carries.
- `lgr-server`: the supervisor (Rust).
- `bin/`: Bun and `mongod`, each pinned by its vendor's sha256 in `packages/server/runtime.lock.json`.
  On Windows, also the VC++ runtime `mongod` links.
- `chrome/`: `chrome-headless-shell`, pinned by `packages/server/pdf-browser.lock.json`.
- `package/`: the API and its apps (`bun run build:server`).
- `licences/`: MongoDB Community Server's SSPL, its notices, and `SOURCE.txt` (the binaries are
  unmodified; their source is the `r<version>` tag of github.com/mongodb/mongo).
