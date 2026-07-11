# Product Hunt — Syncvault

**Name:** Syncvault

**Tagline (60 chars):** Encrypted backups to YOUR bucket. Pay for bytes, not rent.

**Description (260 chars):**
Desktop backup agent: watch folders, AES-256-GCM client-side encryption, content-hash dedupe, N-version history with point-in-time restore — pushed to your own S3-compatible bucket (B2, R2, Wasabi, MinIO) or local drive. $29 once vs backup subscriptions.

**Full description:**
Backup subscriptions charge you monthly for two things: storage bytes and software. The bytes are already cheap everywhere — Backblaze B2 is ~$6/TB/mo, Cloudflare R2 has free egress. Syncvault unbundles the software part and sells it once.

Watch any folders. On schedule (or on click), Syncvault hashes what changed, encrypts each object client-side with AES-256-GCM (key derived from your passphrase via scrypt — it never leaves your machine), and uploads to storage YOU control: any S3-compatible bucket or a local/NAS folder.

Content-addressed dedupe means identical content uploads exactly once, ever. Versioning keeps the last N versions of each file; browse your backup tree as of any point in time and restore a file or the whole folder. Deleted files get tombstones, so history stays intact.

The encrypted format is documented in the README — 20 lines of Node can recover your data without Syncvault. No accounts, no telemetry, no lock-in, MIT source.

**Maker first comment:**
Hi PH 👋 I got tired of paying a backup subscription whose actual product — storage — costs $6/TB at the providers they resell. Syncvault is the missing piece: a one-time-purchase agent that does the hard parts (client-side AES-256-GCM, scrypt key derivation, content-hash dedupe, N-version point-in-time restore) and lets you point it at whatever bucket is cheapest this year. The smoke test literally scans the stored archive bytes for a plaintext marker to prove encryption at rest, and asserts a wrong passphrase fails loudly via GCM auth instead of restoring garbage. Ask me anything about the SV1 format!

**Gallery shots (5):**
1. Main window — watched folders table with schedules and "Back up now" (dark UI)
2. Destinations tab — B2/R2/MinIO S3 config form + local folder option
3. Browse & restore — file tree with version column and as-of date picker
4. Backup log — "3 uploaded, 1 deduped, 0 bytes re-sent" incremental run
5. The SV1 format diagram from the README (encryption transparency)
