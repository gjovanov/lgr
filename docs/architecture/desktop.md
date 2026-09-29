# LGR Desktop — architecture

**Status:** being rebuilt as a **server-mode client**. Local mode was removed on 2026-09-29
(FR-14.34); what is described below is the target, and the sections marked *not built yet* are the
remaining FR-14 chunks.

Specification: [`docs/fr/FR-14-lgr-desktop-app-server-mode.md`](../fr/FR-14-lgr-desktop-app-server-mode.md)
· Tracking: [gjovanov/lgr#57](https://github.com/gjovanov/lgr/issues/57)

## What it is

A Tauri 2 shell, and nothing else. It has **exactly one mode: it opens the LGR cloud app.**

```
┌────────────── LGR Desktop (per OS user) ──────────────────┐
│  Shell (Rust, Tauri 2) — the whole app                    │
│   · tray · single instance · deep links · updater         │
│   · registration + desktop key in the OS keystore         │
│   · native fiscal bridge: owns serial ports, speaks the   │
│     /ws/fiscal-bridge protocol as the registered desktop  │
│   · windows:  main (Overview, Settings…)  ·  lgr-web      │
│                                                           │
│   lgr-web ── https://lgrai.app/<startPath>                │
│              no IPC, the portal's own sign-in             │
└───────────────────────────────────────────────────────────┘
        no sidecar · no Bun · no SQLite · no local data
```

The shell's own pages (`packages/desktop-ui`) are bundled into the binary, so they work with no
network. Everything else is the cloud app, served by the cloud.

## What it adds over a browser tab

- a **native fiscal bridge** that owns the till's serial port — Web Serial exists only in
  Chrome/Edge, and gives a COM port to one tab at a time;
- **autostart with open-on-launch**, so a till is back on the POS by itself after a power cut;
- **auto-update**, a tray, and a redacted diagnostics bundle;
- **registration**, which makes every desktop a known, revocable machine of its org.

## Packages

| Package | What it is |
|---|---|
| `packages/desktop` | the Tauri 2 shell (Rust) |
| `packages/desktop-ui` | the shell's five Vue views: Overview · Settings · Onboarding · Logs · Diagnostics. Built by the root `bun run build`. |

Nothing else. The desktop talks to the same unified API as the browser.

## Not built yet

Overview + **Open LGR** (FR-14.13), OAuth through the system browser (FR-14.14), registration and
the desktop key (FR-14.18–14.23), the updater (FR-14.28), and the native fiscal bridge
(FR-14.26). `desktop-ui`'s views are placeholders until then.

## What was removed, and why it is not coming back

The 2026-03 prototype was an **offline-first** app: a compiled `desktop-api` Bun sidecar over
SQLite (`dal-sqlite`), plus `packages/sync` for LAN peer-to-peer replication. It was dropped on
2026-09-28 after review, and deleted rather than left to rot, because:

- the sidecar started **without `JWT_SECRET`**, so it signed local tokens with the committed
  `'lgr-dev-secret'`, and first run created **`admin` / `admin123`**, logged it in plain text,
  pre-filled it on the login form and **printed it in the release notes**;
- `packages/sync` was imported by nothing;
- `desktop-ui` mounted ~50 routes importing views out of six other UI packages, and was **not in
  `bun run build`**, so it bit-rotted: a deleted view broke its build unnoticed from 2026-08-22 to
  2026-08-26.

⚠ `packages/dal` and `packages/dal-mongo` **stay**. The DAL interface is still what the
repository tests in `packages/tests/src/dal/repos` exercise; only the SQLite implementation went.
