# Launch Strategy — Syncvault

## Target communities

- **r/DataHoarder** — strongest fit; angle: "unbundle backup software from storage rent" with the B2/R2 cost table. They will audit the crypto claims — link the SV1 format doc up front.
- **r/selfhosted** — angle: MinIO/NAS as a destination; a backup agent with no cloud account requirement.
- **r/backblaze** — angle: careful, complementary post: "using B2 as the backend for a one-time-purchase agent" (B2 is the recommended pairing, not the enemy).
- **r/homelab** — angle: versioned encrypted offsite for the homelab, restore tested (`smoke test scans archive bytes for plaintext`).
- **Hacker News** — see Show HN below; the documented format + loud-failure crypto is HN catnip.

## Hacker News "Show HN" draft

**Title:** Show HN: Syncvault — encrypted, versioned backups to your own S3 bucket (one-time purchase)

**Post:** Consumer backup pricing bundles two things: storage (cheap everywhere — B2 is ~$6/TB/mo) and software (the actual product). Syncvault unbundles it: a desktop agent, bought once, that watches folders and pushes client-side AES-256-GCM encrypted objects to any S3-compatible endpoint or local/NAS path. Objects are content-addressed by SHA-256, so dedupe and incrementality fall out of the design; each file keeps its last N versions with point-in-time tree browsing and tombstones for deletions. The SV1 container format is documented in the README (salt/IV/tag header + scrypt KDF) so your data is recoverable with ~20 lines of Node without my software. The smoke test scans raw stored bytes for a plaintext canary and asserts wrong-passphrase restores fail via GCM auth rather than emitting garbage. Electron + better-sqlite3 + aws-sdk v3, MIT. I'd love scrutiny of the crypto choices.

## SEO keywords

1. backblaze alternative self hosted
2. encrypted backup tool byo s3
3. file backup software one time purchase
4. s3 backup client with encryption
5. backblaze b2 backup client windows
6. cloudflare r2 backup tool
7. client side encrypted backup
8. versioned backup software windows
9. minio backup agent
10. backup software no subscription

## AppSumo / PitchGround pitch

Syncvault turns any cheap object storage — Backblaze B2, Cloudflare R2, Wasabi, or a MinIO box in the closet — into a private, encrypted, versioned backup service. Client-side AES-256-GCM means the storage provider (and we) can never read a byte; content-hash dedupe keeps bandwidth and storage bills tiny; point-in-time restore brings back any file as it was on any date. It's a one-time purchase replacing perpetual backup subscriptions, with a documented open format that guarantees buyers can always recover their data. For the LTD audience that already hates SaaS rent, "pay once, then pay only $6/TB to whoever's cheapest" is the cleanest pitch in the utilities category.

## Pricing math

**$29 one-time** vs Backblaze Personal $9/mo → **pays for itself in 3.2 months.** Year-one total for 100 GB: Syncvault ≈ $36 ($29 + ~$7 B2 storage) vs Backblaze $108 vs iDrive $79.86. Every year after: ~$7 vs $108.
