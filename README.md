# Stuyvesant Rod & Gun Club website

The club website runs entirely in the club's **Cloudflare** account:

| Part | Where it lives in Cloudflare |
|---|---|
| Web pages (`index.html`, `admin.html`) and the site code (`worker.js`) | Workers & Pages → **srgc** |
| Hours, events, notice banner, photos, officer logins | Storage & Databases → D1 → **srgc-db** |

If GitHub disappears, the site keeps running. Day-to-day changes never touch GitHub.

## Day-to-day: the Site Manager
Go to **`/admin`** on the website (for example `https://srgc.afedorov2013.workers.dev/admin`) and sign in.

- **Hours & notice**: weekly hours, the note under them, and the banner across the top of the site.
- **Calendar**: add, edit or delete events. A **Closure** event marks the range closed on those dates.
- **Photos**: upload, caption, choose the cover photo, delete.
- **Notify members**: builds an email from the current schedule, then opens Gmail addressed to the members' Google Group. Check it and press Send.
- **Officers**: add officers, reset passwords, remove officers, change your own password.

Changes are live as soon as you save.

## If everyone is locked out
1. Sign in to Cloudflare → Workers & Pages → **srgc** → Settings → Variables and Secrets.
2. Look up or change the secret **SETUP_KEY** (you can "Rotate"/edit it to a new value).
3. Go to `/admin`, choose **Use setup key**, and create or reset an officer with that key.

## First-time setup (done once)
1. In Cloudflare: Workers & Pages → **srgc** → Settings → Variables and Secrets → **Add** → type *Secret*, name `SETUP_KEY`, value = a long random phrase. Store it with the club's records.
2. Open `/admin` → enter the setup key and create the first officer.
3. Add the other officers from the **Officers** tab.

## Changing the site's design or code (rare)
The code is the files in this folder. To publish a change without GitHub: Workers & Pages → **srgc** → upload a new version, or run `npx wrangler deploy` from this folder while signed in to the club's Cloudflare account.
`data.json` is only used once, to fill the database the very first time the site runs. After that, edit everything in `/admin`.
