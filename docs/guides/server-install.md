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
| Docker Compose, Kubernetes (k3s), x64 | `ghcr.io/gjovanov/lgr-server:<v>`, or `lgr-server-<v>-image-amd64.tar.zst` with `lgr-server-<v>-compose.yaml` and `lgr-server-<v>-k8s.yaml` | the image | a volume at `/var/lib/lgr` |

Each asset has a `.sha256` and a `.asc`, and the release carries SLSA build provenance (the image
on GHCR too).

## What the machine needs (FR-20.13)

- **CPU:** x86-64 with **AVX**, or ARMv8.2-A: MongoDB 5.0 and later will not start without it. Old
  Celeron and Atom shop PCs, and the Raspberry Pi 4, do not have it.
- **Memory:** a machine with at least **4 GB** of RAM. The OS never reports all of it (firmware, an
  integrated GPU and the kernel keep some), so the check asks for 3.25 GB usable.
- **Disk:** **20 GB** free where the data goes, on a **local, fixed disk**: never a network share,
  a removable drive, a RAM disk, tmpfs, or a container's own layer (a container's data is a volume).

**The MSI and the .deb check before they install anything**, and on a machine that falls short they
install nothing and say why: the MSI in a message box (and in its log, `msiexec /l*v`), the .deb on
apt's output. Only on a first install: an upgrade is never refused. The tarball does not check;
`lgr-server preflight` says what the machine has.

The service checks again at every start. It refuses to start only without AVX, without the VC++
runtime `mongod` links (Windows) or with its data on a share, tmpfs or overlayfs (a container's own
layer, or a live system's). Below the memory or disk floor
it starts, and warns: a master that has run for months is not stopped at a reboot because its disk
has 19 GB free.

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

## Docker Compose and Kubernetes

The image is the .deb's own home (gjovanov/lgr#367): Ubuntu 24.04, `/opt/lgr-server/versions/<v>/`,
the supervisor as its main process with `mongod` and the API as its children, exactly as on a .deb,
all running as `lgr` (uid and gid **10001**, fixed from one image to the next). Everything the
server keeps is on **one volume at `/var/lib/lgr`**: the database, the keys, the backups and
`config/api.env`. It runs on the **host's network**: the setup console and `mongod` stay on the
host's loopback, the LAN ingress is the host's 4443, and the tills find the server by multicast
DNS-SD, which a bridge network does not carry.

The machine is checked where the container runs, at every start: the memory is the container's
limit when it has one (the server sizes `mongod`'s cache for it), and the data must be on a volume.
A server whose `/var/lib/lgr` is the container's own layer (overlayfs) refuses to start, because
that layer goes with the container.

### Compose

Put the release's `lgr-server-<v>-compose.yaml` in a folder of its own as `compose.yaml` (the one
in `packages/server/packaging/docker/` takes the version from `LGR_SERVER_VERSION` instead), then:

```bash
docker compose up -d
docker compose exec lgr-server lgr-server setup-token
```

and open the link it prints in a browser **on that machine**. Every command in this guide runs the
same way: `docker compose exec lgr-server lgr-server status`. The supervisor logs to `docker
compose logs`; the API's and `mongod`'s logs are in the volume, under `/var/lib/lgr/logs/`.

**Air-gapped:** check the image's `.asc` like any asset, then
`zstd -dc lgr-server-<v>-image-amd64.tar.zst | docker load`. Compose uses the image it finds and
pulls nothing.

### Kubernetes (k3s)

```bash
kubectl apply -f lgr-server-<v>-k8s.yaml
kubectl -n lgr-server exec deploy/lgr-server -- lgr-server setup-token
```

One pod (`Recreate`, never a rolling update) with `hostNetwork`, its data on a k3s `local-path`
volume, which keeps it on that node. The setup link opens on the node itself, or through
`ssh -L 4480:127.0.0.1:4480 <node>`. **Air-gapped:** put the release's `.tar.zst` in
`/var/lib/rancher/k3s/agent/images/` on the node before applying. The namespace is labelled for the
`privileged` Pod Security level, because `hostNetwork` is beyond `baseline`.

### Updates, settings and backups in a container

- **An image is updated by its tag.** `lgr-server update apply` refuses in a container: what it
  installed would run with nothing to watch it, and be gone with the container. Take a backup first
  (`lgr-server backup now`: the .deb's updater takes one before every switch, and here nobody else
  does), then the next release's compose or k8s file, or the next `LGR_SERVER_VERSION`, and
  `docker compose up -d`. A registered server's `lgr-server status` says when a version is offered
  (`update image <v> available`).
- **Settings** are `/var/lib/lgr/config/api.env` in the volume, as on any Linux master: edit it
  through `docker compose exec`, then `docker compose restart`.
- **`BACKUP_LOCAL_PATH`** must be another disk than the volume's, mounted into the container (for
  example `- /mnt/usb:/backup`, and `BACKUP_LOCAL_PATH=/backup`). A folder on the volume's own disk
  is refused like any other.
- `TZ` (in the compose and k8s files) is the shop's time zone, for the server's own maintenance
  times.

### What never to do

- **Bridge networking or published ports.** Never publish 27118 (`mongod`) or 4480 (the setup
  console) beyond the machine.
- **Two containers on one volume**, or the image beside a .deb install on the same machine: two
  servers on one database corrupt it, and both want the same ports.
- **`docker compose down -v`**: `-v` deletes the volume, which is the whole server.
- **A bind mount the container cannot write**: a host folder for `/var/lib/lgr` must belong to
  10001:10001 (`sudo chown -R 10001:10001 <folder>`). A named volume needs nothing.
- The address-conflict check (gjovanov/lgr#356) needs the `NET_RAW` capability, which the image's
  unprivileged supervisor does not hold: in a container it does not run.

## Versions and updates

The packages install a version beside the others and point the service at it (FR-20.20):

| | Windows | Linux |
|---|---|---|
| a version | `C:\Program Files\LGR Server\versions\<v>\` | `/opt/lgr-server/versions/<v>/` |
| what the service runs | the service's image path | `/opt/lgr-server/current` |
| what the update helper runs | its image path: the last version known to work | `/opt/lgr-server/lkg` |
| the update state | `...\LGR Server\update\state.json` | `/opt/lgr-server/update/state.json` |

- **A switch is watched.** The update helper confirms a new version once the service has run
  cleanly for 5 minutes (the supervisor up that long, and the API serving that long by its own account), and switches back to the
  previous version by itself, from disk and offline, if it crash-loops (it dies and is started again
  3 times in 10 minutes), stays down, or never runs cleanly within 20 minutes. A version that failed
  is never switched to again, and an older one never at all.
  - A restart someone asks for is not a crash (an administrator's, say). It only delays the
    confirmation, which needs 5 clean minutes of one process.
- **Two versions stay on disk:** the one that runs and the one before it.
- `lgr-server update status`: what runs, what is known good, what failed and what is on disk.
- **Before every switch a backup is taken** of every org on the server, where its backups go. No
  backup, no switch. `lgr-server backup now` takes the same one by hand.
- The helper's log is `update/helper.log` under the install, on both systems
  (`/opt/lgr-server/update/helper.log` on Linux). `journalctl -u lgr-server-update` shows only
  when systemd started and stopped it.
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

### Security updates on Ubuntu and Debian

unattended-upgrades installs the distribution's security updates every morning, and needrestart
then restarts every service still running a library they replaced. The .deb tells needrestart to
leave the server alone (`/etc/needrestart/conf.d/lgr-server.conf`): it lists `lgr-server` and never
restarts it. A restart in the middle of a sale is the shop's to avoid, and a server that is switched
on at opening time runs those upgrades right then.

The server restarts itself instead, at night:
- Every 10 minutes it looks for a system library (under `/usr`, `/lib`, `/lib64`) that was replaced
  under one of its processes: itself, the database, the API, the PDF browser.
- Once one was, it restarts inside `UPDATE_WINDOW` (22:00–06:00 by default), when no till has a
  session open and no receipt is printing, at most once a night, and never while the update helper
  watches a new version.
- It restarts in place: its processes stop as on `systemctl stop` (the API finishes a receipt in
  flight) and start again under the same service process, so systemd counts no restart. The version
  that runs is the version that starts again: one a package installed meanwhile waits for the
  service's next start, where the update helper watches it.
- `lgr-server status` says what waits, for example
  `restart  pending: libssl.so.3 replaced; waits for the maintenance window, 22:00-06:00`.
- `NIGHT_RESTART=off` in `config/api.env` turns it off. The new libraries then run from the next
  `sudo systemctl restart lgr-server`.
- To watch it happen without waiting for the night, set a window around now
  (`UPDATE_WINDOW=00:00-23:59`) and restart the service once. ⚠ That window lets an automatic
  update install at any hour too: put it back afterwards.

## Setup (FR-20.18)

A new server has to be set up once, on the server itself. As an administrator (root on Linux), run

    lgr-server setup-token

and open the link it prints in a browser on that machine. It works only there (`127.0.0.1`), and
only until setup is complete. The page asks, in order:

1. **How the server links to lgrai.app.** Air-gapped (never connects), or registered at Control or
   Full with a code an admin of the organization mints on lgrai.app's Servers page.
2. **The organization.** Air-gapped: you create it here, with its first administrator, who is
   active at once (an air-gapped server has no mail to activate anyone with: holding the setup link
   is the proof). Linked: an admin moves the organization here from the Servers page on lgrai.app,
   and its people come with it.
3. **LAN access and the backup copy.** Whether the shop's tills may connect over the network
   (HTTPS on port 4443), and a folder on a USB drive or another disk for a copy of every backup.
   The server restarts its services to apply them (about half a minute).
4. **The first till** (optional, but do it): sign in as the administrator and make a pairing code,
   then enter it in LGR Desktop on the till.
5. **Finish.** The setup page closes for good: registering an organization is off, the server's
   owner becomes the one who may restore backups (`BACKUP_SYS_ADMINS`), and the server opens to its
   tills (and, when linked, to the organization's address on lgrai.app).

After setup, a till pairs from the Desktops page of a till already paired. To run setup again (a new
first till, another organization), an administrator runs `lgr-server setup reset`: it prints a new
link (the old one stops working) and reopens the page with what was chosen before.

## After installing

- `lgr-server status`: the supervisor, its children and its link.
- `lgr-server setup-token`: the link that opens the setup console.
- `lgr-server setup reset`: open setup again, with a new link.
- `lgr-server register --code XXXX-XXXX`: register with lgrai.app from the command line instead
  (the code comes from the org's Servers page).
- `lgr-server licence import <file>`: an air-gapped server's licence.

## Another machine with this server's address (Linux)

The server watches its LAN address (RFC 5227): now and then it asks the network who holds the
address, and it reads every ARP packet on that interface. If another machine answers for it,
`lgr-server status` says so:

```
  address  192.168.1.20 claimed by 52:54:00:ab:cd:ef since 2026-10-29T10:00:00Z (last 2026-10-29T10:05:00Z)
```

The log and `state/address-conflict.json` under the data directory say so too. The tills then reach
one machine or the other.

- **The usual cause is a copy of this server's disk** on another PC. The copy keeps
  `/etc/machine-id`, the DHCP client id comes from it, and the router gives both machines one
  address. `PROBABLY A CLONE` at the end of the line means an advert names this server, from another
  start, at that address too. Until it is dealt with, both machines are homes of the same orgs and
  issue the same numbers. On the copy, as root:
  1. `rm /etc/machine-id && systemd-machine-id-setup`;
  2. reboot it;
  3. install it again as a new server.
- A copy at **another** address is the clone check's: it proves the copy holds this server's keys,
  and locks legal numbering. This watch proves nothing, so it warns and locks nothing.
- It needs `CAP_NET_RAW`, which the supervisor binary carries as a file capability
  (`getcap /opt/lgr-server/current/lgr-server` prints `cap_net_raw=p`).
  - Installing a version writes it: the package, an update, and `lgr-server service install`. The
    supervisor uses it to open its socket and drops it at once. The API, `mongod` and the PDF browser
    are other programs and never hold it.
  - Where it is missing or not honoured, the status line reads `address  not watched:` and says why.
    Possible causes:
    - a version installed by one from before this check; the next update or package install gives it
      one;
    - `NoNewPrivileges=` in a drop-in;
    - `/opt` mounted `nosuid`;
    - a container or unit that drops `CAP_NET_RAW`.

    The server runs either way.
- Windows needs none of this: a copy of a Windows disk keeps its MAC-based DHCP client id, gets an
  address of its own, and the clone check sees it.

## Settings: `config/api.env`

The operator's settings are in `config/api.env` under the data directory
(`C:\ProgramData\LGR\config\api.env`, `/var/lib/lgr/config/api.env`), one `NAME=value` per line.
The service reads them when it starts, so restart it after a change: `Restart-Service LGRServer`,
`sudo systemctl restart lgr-server`, or `docker compose restart`.

What setup chose is kept apart, in `state/setup.json`, and this file **overrides** it: a line here
always wins, and setup never edits this file. Set something here only to change what setup chose.

| Setting | What it does |
|---|---|
| `LAN_INGRESS=on` | Opens the LAN ingress, HTTPS on `LAN_PORT`, so the shop's tills can pair and connect. **Off by default:** a server with no tills opens nothing on the LAN. Pairing codes then name this machine's address, from the server's Desktops page. |
| `LAN_PORT` | The LAN ingress's port, 4443 by default. |
| `LGR_LAN_NAMES` | Names the server answers to on the LAN besides the machine's own and `<machine>.local`, comma-separated. A request for any other name is refused; an IP address always works. |
| `SETUP_PORT` | The setup console's port on loopback, 4480 by default. |
| `BACKUP_LOCAL_PATH` | A second disk, a USB drive or a share, for a copy of every night's backup (`<path>/LGR/Backups/<org>/<kind>/`). It must be **another disk** than the server's data. A folder on the same disk is refused, because a copy beside the database is no copy, and so is a drive that is not there (unplugged, or a share that is down). Mount the drive where the service can write. |
| `BACKUP_LOCAL_KEEP` | How many generations the local copy keeps. |
| `UPDATE_WINDOW`, `UPDATE_AUTO` | The nightly update window: see [Versions and updates](#versions-and-updates). |
| `NIGHT_RESTART` | Linux: `off` stops the server restarting itself at night for a library a security update replaced. See [Security updates](#security-updates-on-ubuntu-and-debian). |

## What is inside a version

`HOME.json` says what the home is: its version, commit, target and the versions it carries, and
how many files and bytes it holds, which is how an install knows it is complete.
- `lgr-server`: the supervisor (Rust).
- `bin/`: Bun and `mongod`, each pinned by its vendor's sha256 in `packages/server/runtime.lock.json`.
  On Windows, also the VC++ runtime `mongod` links. No redistributable is installed system-wide,
  and the preflight's `vc-runtime` check looks here before System32.
- `chrome/`: `chrome-headless-shell`, pinned by `packages/server/pdf-browser.lock.json`.
- `package/`: the API and its apps (`bun run build:server`).
- `licences/`: MongoDB Community Server's SSPL, its notices, and `SOURCE.txt` (the binaries are
  unmodified; their source is the `r<version>` tag of github.com/mongodb/mongo).
