# Shared collection setup

The hosted app reads the shared collection from Supabase. Only the configured
owner can publish or change it. Local `file://` HTML backups remain offline and
editable without sign-in.

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
- If cloud loading fails, the app clearly labels the local fallback and disables
  edits. It does not silently publish that fallback over existing cloud data.
- Sign-in is remembered for the current browser tab session. Passwords are never
  included in HTML exports. Sign out on shared devices.

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
