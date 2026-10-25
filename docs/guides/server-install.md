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
- installs the version it carries into `C:\Program Files\LGR Server\versions\<v>\` (see
  [Versions](#versions-and-updates));
- registers the service **LGR Server** (`LGRServer`), automatic, as `NT SERVICE\LGRServer`, with
  restarts after 5, 30 and 60 seconds, and starts it;
- registers **LGR Server Update** (`LGRServerUpdate`), the update helper, as LocalSystem;
- opens the firewall for the version's `lgr-server.exe` on the Domain, Private and Public
  profiles, from the local subnet only (Windows marks a new network Public);
- refuses to downgrade. A newer MSI installs its version beside the running one and switches to it.

Uninstalling (Settings, or `msiexec /x`) removes both services, the firewall rule and every
version, and **keeps the data**.

Commands run through the installer's copy, which hands them to the version that runs:
`& "C:\Program Files\LGR Server\installer\lgr-server.exe" status`.

## Ubuntu and Debian

```bash
sudo apt install ./lgr-server_<v>_amd64.deb
sudo systemctl enable --now lgr-server
```

The package depends on the distribution's poppler-utils and tesseract-ocr (with Bulgarian), which
the server reads PDFs with, offline. It creates the `lgr` user and `/var/lib/lgr`, installs the version it carries into
`/opt/lgr-server/versions/<v>/` with `/opt/lgr-server/current` pointing at it (see
[Versions](#versions-and-updates)), and installs the units `lgr-server.service` and
`lgr-server-update.service` (the update helper) under `/usr/lib/systemd/system/`. ⚠ It never
starts, stops or restarts the service itself, on install or on upgrade (roomler's rule), so an
upgrade never interrupts a till in the middle of a sale: the new version runs from the service's
next start. Restart it when it suits the shop: `sudo systemctl restart lgr-server`.

`apt remove` stops the service and removes every version and **keeps the data**.

## The tarball

The tarball is the update bundle the .deb carries. Unpacked by hand, it is a home that runs where
it is, without versions or the update helper: let the supervisor register itself with systemd.

```bash
sudo tar xzf lgr-server-<v>-x86_64-unknown-linux-gnu.tar.gz -C /opt
sudo mv /opt/lgr-server-<v>-x86_64-unknown-linux-gnu /opt/lgr-server-home
sudo /opt/lgr-server-home/lgr-server service install
```

Its `mongod` is MongoDB's Ubuntu 22.04 build: it needs glibc 2.35, OpenSSL 3 and libcurl.

## Versions and updates

The packages install a version beside the others and point the service at it (FR-20.20):

| | Windows | Linux |
|---|---|---|
| a version | `C:\Program Files\LGR Server\versions\<v>\` | `/opt/lgr-server/versions/<v>/` |
| what the service runs | the service's image path | `/opt/lgr-server/current` |
| what the update helper runs | its image path: the last version known to work | `/opt/lgr-server/lkg` |
| the update state | `...\LGR Server\update\state.json` | `/opt/lgr-server/update/state.json` |

- **A switch is watched.** The update helper confirms a new version once the service has run
  cleanly for 5 minutes (the supervisor and the API up that long), and switches back to the
  previous version by itself, from disk and offline, if it crash-loops (3 restarts in 10 minutes),
  stays down, or never runs cleanly within 20 minutes. A version that failed is never switched to
  again, and an older one never at all.
- **Two versions stay on disk:** the one that runs and the one before it.
- `lgr-server update status`: what runs, what is known good, what failed and what is on disk.
- The helper's log is `update/helper.log` (Windows); on Linux,
  `journalctl -u lgr-server-update`.
- **Automatic updates** (a server registered with lgrai.app): every night between 22:00 and 06:00,
  when no till has a session open and no receipt is printing, the server installs the version
  lgrai.app offers it, after checking both signatures against the keys it carries. In
  `config/api.env`:
  - `UPDATE_WINDOW=01:00-05:00`: another window, in the machine's local time;
  - `UPDATE_AUTO=off`: no automatic updates.

  If open tills keep an update out for 7 nights, `lgr-server status` and the Servers page on
  lgrai.app say so. Close the tills at night.
- **By hand** (a server with no internet): download the bundle and its `.sig` (and on Linux its
  `.asc`) from the release, then as an administrator or root:
  ```
  lgr-server update apply lgr-server-<v>-x86_64-unknown-linux-gnu.tar.gz --sig <...>.tar.gz.sig --asc <...>.tar.gz.asc
  ```
  It refuses a bundle whose signatures do not check out, an older version, and a version that
  failed here before.

## After installing

- `lgr-server status`: the supervisor, its children and its link.
- `lgr-server setup-token`: the link that opens the setup console.
- `lgr-server register --code XXXX-XXXX`: register with lgrai.app (the code comes from the org's
  Servers page).
- `lgr-server licence import <file>`: an air-gapped server's licence.

## What is inside a version

`HOME.json` says what the home is: its version, commit, target and the versions it carries, and
how many files and bytes it holds, which is how an install knows it is complete.
- `lgr-server`: the supervisor (Rust).
- `bin/`: Bun and `mongod`, each pinned by its vendor's sha256 in `packages/server/runtime.lock.json`.
  On Windows, also the VC++ runtime `mongod` links.
- `chrome/`: `chrome-headless-shell`, pinned by `packages/server/pdf-browser.lock.json`.
- `package/`: the API and its apps (`bun run build:server`).
- `licences/`: MongoDB Community Server's SSPL, its notices, and `SOURCE.txt` (the binaries are
  unmodified; their source is the `r<version>` tag of github.com/mongodb/mongo).
