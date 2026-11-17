# Shared collection setup

The hosted app reads the shared collection from Supabase. Only the configured
owner can publish or change it. Local `file://` HTML backups remain offline and
editable without sign-in.

## Hosted build and offline backups

Netlify runs `npm run build` and publishes `dist/index.html` and the static
`dist/assets/` directory, including the header logo. The build
empties the embedded collection CSV, snapshot metadata, fetched metadata,
covers and artist photos, retaining the placeholders needed by HTML export.
Fixed reference content (such as jazz definitions and curated artist/album
background notes) remains part of the application.
The source `index.html` is not overwritten or published directly.

The hosted shell loads the current collection and images from Supabase. It does
not use an embedded collection or old browser imports as a fallback. If Supabase
is unavailable, it shows an explicit error and disables editing and HTML backup
export until loading succeeds. Use **Load latest cloud collection** to retry.
An unpublished database starts empty; the signed-in owner can import an existing
HTML backup or CSV to populate it.

Records, filters and counts become available as soon as the collection metadata
loads. Covers are fetched near the viewport; artist photos wait until their
view is opened. Artwork requests are deduplicated and limited to three concurrent
batches of up to ten images. An artwork status line reports loading or failures;
**Retry artwork** retries failed images without reloading the collection.

Immutable image content is cached in IndexedDB by its Supabase hash. Subsequent
visits still fetch the latest collection metadata, but unchanged artwork is
reused locally; a changed hash downloads a new image. Cache failures are reported
and do not prevent browsing or downloading images.

**Save HTML to...** still creates a standalone backup containing the currently
loaded records, notes, scores, covers, artist photos and fetched metadata.
Exports from the hosted site also embed the header logo. Opening
that exported file locally works offline without Supabase. Keep an export before
switching an existing deployment to the hosted shell.
Export waits for any remaining artwork, including photos not yet viewed. Missing
images fail the export explicitly instead of creating an incomplete backup.
Ordinary cloud saves and recovered pending edits preserve unresolved image
references, so editing before artwork finishes cannot drop covers or photos.

Deploy using Netlify's Git build, not a drag-and-drop upload of the source HTML.
The publish directory must be `dist`; functions remain in `netlify/functions`.
For local checks, run `npm run build`, `node --test tests/build.test.js`, and
`npm run test:e2e`. The browser tests build and exercise the hosted shell as well
as the original offline-capable source.

## Setup

1. Run [setup.sql](./setup.sql) in the Supabase SQL Editor.
2. Create the owner account in Authentication > Users. The account UID must
   match the UID in the SQL policies/function and the app's cloud configuration.
3. Keep the Project URL and **publishable** key in the app configuration. Never
   put a service-role key, secret key, or password in the HTML or repository.
4. Deploy the project to Netlify over HTTPS.
5. In Collection tools, choose **Owner sign in** and enter the owner credentials.
6. Check the initial collection, then choose **Publish collection**. This
   publishes records, notes, scores, images, and fetched metadata for public
   viewing. Save an HTML backup before publishing.
7. Open the hosted URL in another browser to confirm it loads the shared data.

Email/password sign-in is used; there is no email redirect flow requiring the
Netlify URL during initial setup. Configure Supabase's Site URL when the hosted
URL is known, particularly before using password-reset email flows. Public
sign-ups can be disabled; creating another account does not grant owner access.

## Saving and recovery

- Owner changes save automatically after a short delay. Wait for **Saved to
  cloud** before closing the page. Display preferences and the listening queue
  remain local.
- **Save / retry cloud changes** retries failed saves. Pending snapshots are
  stored in this browser's IndexedDB and recovered after reload for the signed-in
  owner. Browser storage can still be cleared or unavailable; keep HTML/CSV backups.
- If another browser saved first, the server rejects the stale write. Export
  your pending edits, then use **Load latest cloud collection**. It explicitly
  asks before discarding pending changes. There is no automatic conflict merge.
- Other open tabs do not receive live updates. Open/reload the site or choose
  **Load latest cloud collection** to fetch the latest version.
- HTML import while signed in replaces the shared collection after an additional
  confirmation. CSV import merges records and saves the result to the cloud.
- If cloud loading fails on the hosted shell, the app shows an error without
  displaying stale collection data and disables edits. Older self-contained HTML
  deployments can still show their clearly labeled local fallback.
- Sign-in lasts for the current browser tab session by default. Select **Remember
  me on this device** when signing in to keep the session across closing and
  reopening the site, including an iPhone home-screen shortcut. Use this only on
  trusted devices: session tokens are saved in local storage, not the password.
  Tokens refresh when needed; Supabase session expiry/revocation or clearing
  browser storage can still require signing in again. Sign out removes the saved
  session from this browser. Safari and home-screen shortcuts may use separate
  storage, so sign in in the one you use. Passwords and the remember-me selection
  are never included in HTML exports.

## Storage and access

`collection_state` stores a versioned collection snapshot. `save_collection`
checks the owner UID and atomically compares the version before saving.
Anonymous users have SELECT permission only.

`collection_assets` stores immutable, content-addressed image data. Unchanged
images are reused instead of uploaded with each note edit. Old, unreferenced
assets are retained, so monitor storage usage as the collection grows.

The free Supabase tier can pause inactive projects. Resume the project in
Supabase if it becomes unavailable. Netlify deployment does not back up database
contents; keep independent exports.

## Background Discovery on Netlify

Discovery keeps the configured `GEMINI_DISCOVERY_MODEL` (default
`gemini-3.8-flash`). The `discovery` function queues work and returns a job ID
immediately. `discovery-background` generates the 12 candidates; the page polls
for results and still filters owned albums locally to show three suggestions.
Album summaries remain synchronous and use their separate model setting.

- Deploy the whole repository through Netlify's Git build, including
  `package.json` and `package-lock.json`; uploading only the HTML is not enough.
  The build uses Node.js 22 and installs `@netlify/blobs`.
- Keep the Discovery storage helper as an ES module with a static import of
  `@netlify/blobs`, so Netlify's dependency tracer includes the SDK in each
  deployment archive.
- The Netlify plan must support Background Functions and Netlify Blobs.
  Modern function entry points are used for automatic Blobs credentials.
  No new secret key or Supabase table is needed.
- Keep `GEMINI_API_KEY` and any `GEMINI_DISCOVERY_MODEL` override available in
  the **Functions** environment scope, including the background worker.
- Background dispatch uses Netlify's read-only runtime `URL` variable. Do not
  substitute `DEPLOY_URL`, which is a build-time variable and is not guaranteed
  in Functions. Dispatch targets the site's main published URL.
- Generation has a two-minute deadline. The page polls every two seconds for
  up to three minutes; individual submit/status requests time out after 15 seconds.
  Keep the Discovery dialog open. Closing or reloading stops waiting and does
  not cancel an already accepted server job.
- Jobs use unguessable IDs, expire after ten minutes, and are deleted by the
  hourly `discovery-cleanup` scheduled function. Clues are removed from the stored
  job as soon as generation finishes. Cleanup runs automatically on the published
  production deploy, not Deploy Previews.
- If submission fails, inspect the `discovery` function logs. For generation
  failures inspect `discovery-background`; job data is in the `discovery-jobs`
  Blobs store. Do not share API keys or the contents of private jobs.
