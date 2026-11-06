# Bluesky auto-posting

Posts one entry per day from `posts.json` to Bluesky (@mirumiru77.bsky.social), at 22:47 Japan time, via the GitHub Actions workflow `.github/workflows/bluesky.yml`.

- Each entry has a `date` (Japan time) and `text` (max 300 characters). Days with no entry are skipped.
- Secrets required: `BSKY_HANDLE`, `BSKY_APP_PASSWORD` (a Bluesky app password).
- Test the login without posting: Actions → Bluesky daily post → Run workflow (login_only checked).
- Preview locally: `DRY_RUN=1 POST_DATE=2026-11-12 node bluesky/post.mjs`
