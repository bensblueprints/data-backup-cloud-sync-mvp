# 🔐 Syncvault

## Get the packaged app

Don't want to build from source? Get the signed installer, lifetime updates and setup support for a one-time payment at [onetimesuite.com/syncvault](https://onetimesuite.com/syncvault/) — same app, MIT source right here.

Part of [OneTimeSuite](https://onetimesuite.com) — pay-once alternatives to subscription software.

## Demo



https://github.com/user-attachments/assets/7730e3c5-b542-4b07-8111-a0ebea8bbde3



**Encrypted backups to storage you own. Pay once — no Backblaze subscription.**

![MIT License](https://img.shields.io/badge/license-MIT-green) ![Electron](https://img.shields.io/badge/desktop-Electron-blue)

Syncvault is a desktop backup agent: watch folders, encrypt everything client-side with AES-256-GCM, and push versioned, deduplicated backups to **your own** S3-compatible bucket (AWS S3, Backblaze B2, Wasabi, Cloudflare R2, MinIO) or a local/network drive. Your recurring cost is your storage provider's bytes (~$6/TB/mo on B2) — not a software subscription stacked on top.

![screenshot](docs/screenshot.png)

## Features

- **Client-side AES-256-GCM encryption** — key derived from your passphrase (scrypt), never uploaded, never stored in plaintext. Wrong passphrase fails loudly (GCM auth), never silently corrupts.
- **Content-addressed dedupe** — objects are keyed by SHA-256 of content: identical files (or unchanged files across runs) upload exactly once. Incremental by design.
- **Versioning** — keep the last N versions of every file (configurable); browse the backed-up tree **as of any point in time** and restore single files or whole folders.
- **BYO destinations** — any S3-compatible endpoint or a plain local/network folder. Mix per-folder.
- **Scheduling** — manual, continuous (5 min), hourly, or daily per folder; deletion tombstones track removed files without losing history.
- **100% local** — SQLite index on your machine, zero telemetry, no accounts.

## The SV1 format (documented, not proprietary)

```
bytes 0..2    magic "SV1"
bytes 3..18   salt   (16 B, random per object)
bytes 19..30  IV     (12 B)
bytes 31..46  GCM auth tag (16 B)
bytes 47..    AES-256-GCM ciphertext
key = scrypt(passphrase, salt, 32) N=16384 r=8 p=1
```

Your data is recoverable with ~20 lines of Node — no vendor lock-in, even from us.

## Quick start

```bash
npm i
npm start        # opens the Syncvault desktop app
```

First run: set a vault passphrase → add a destination → watch a folder → **Back up now**.

`npm run dist` builds the Windows NSIS installer (electron-builder).

## Real cost math (honest)

| | Syncvault + B2 | Backblaze Personal | iDrive |
|---|---|---|---|
| Software | **$29 once** | $9/mo forever | $79.86/yr |
| 100 GB stored | ~$0.60/mo (your B2 bill) | included | included |
| Client-side encryption | ✅ your key | opt-in | ✅ |
| Any S3 provider | ✅ | ❌ their cloud | ❌ their cloud |
| Version browsing (point-in-time) | ✅ | ✅ 30d | ✅ |
| Dedupe | ✅ content-hash | ✅ | ✅ |
| Works with local/NAS targets | ✅ | ❌ | partial |

A 100 GB backup: **$29 once + ~$7/yr storage** vs $108/yr (Backblaze) — the software pays for itself in ~4 months, then it's just bytes.

## ☕ Skip the setup — get the 1-click installer

Grab the packaged Windows installer at **[whop.com/onetime-suite](https://whop.com/benjisaiempire/syncvault-app)**. Pay once. Own it forever. No subscription.

## Tech stack

Electron · Node crypto (AES-256-GCM + scrypt) · better-sqlite3 · @aws-sdk/client-s3

## License

MIT © 2026 Ben (bensblueprints)

## macOS build

See [MAC-BUILD.md](MAC-BUILD.md). Quickest path: GitHub **Actions** tab -> run the **Mac Build** (`mac-build.yml`) workflow to get a downloadable `.dmg` (unsigned - right-click -> Open on first launch).
