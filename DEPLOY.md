# Deploying XReels (Vercel & friends)

XReels is a **static site**: no build step, no server, no framework. Deploy the
folder as-is and it runs. **Permanent deletion is the optional exception:** it
needs the server function and write access described in section 7. Browsing,
importing and hiding still work without a server.

---

## 1. "Why does my deployment open without a password?"

Because **the PIN in Settings → Privacy is a per-browser lock**, not a password
for the site:

| | PIN (Settings → Privacy) | Site password (`site.config.js`) |
|---|---|---|
| Lives in | this browser's IndexedDB / localStorage | the deployment (`site.config.js`) |
| Scope | one browser, one device | everyone who opens the URL |
| Set from | inside the app | the CLI: `npm run site:password -- "…"` |
| Asks on | every launch of *this* browser | every launch of *the site* (any browser) |

A PIN is stored under the origin you set it on. Open the app from
`file:///…/index.html` and the PIN is there; open the Vercel URL and that
origin has **no** PIN record — the app correctly finds no lock and opens.
Nothing was broken: the lock simply never existed on that origin.

So: **use the site password for a deployment**, and keep the PIN for the local
copy.

---

## 2. Set the password of the deployment

```bash
npm run site:password -- "your password"          # sets it
npm run site:password -- "your password" --hint "the usual"
npm run site:password -- --clear                  # removes it again
```

The command rewrites `site.config.js` with a random salt and the salted
SHA-256 digest of your password. **The password itself is never written to
disk** — only the digest, exactly like the PIN.

```
window.XREELS_SITE = {
  salt: "…", hash: "…", hint: "the usual", title: "XReels",
};
```

Afterwards **redeploy** — the change is a file, it only takes effect once it is
published. The visitor then gets a full-screen password prompt before the app
boots, and **on every load** — the password is never remembered or cached in
the browser, so closing the tab (or reloading) asks for it again.

Leave `salt`/`hash` empty and the site opens straight away — that is what a
local, double-clicked copy wants.

---

## 2b. Opening hours — a password that does not work all the time

The site password can be given **opening hours**: a calendar that decides, for
every minute of every day, whether the password is accepted. The point is to
make the library *not* available all the time — a self-discipline tool, built
so that it cannot be reasoned around in the moment.

```bash
npm run site:password -- --hours on               # the password only works inside its windows
npm run site:password -- --hours off              # back to "works around the clock"
npm run site:password -- --hours on --seed "autumn"   # reshuffle the calendar, keep the password
npm run site:password -- --grace 3                # minutes to finish after a window closes (0–30, default 5)
npm run site:hours                                # preview: this month, today's windows, the status right now
npm run site:hours -- --month 2026-11 --day 2026-11-03
```

This writes an `availability` block into `site.config.js`; redeploy for it to
take effect:

```
availability: { enabled: true, seed: "", graceMinutes: 5 },
```

### The calendar

Everything is computed from a seed and the clock — nothing is stored, nothing
is random at run time, so a reload, another browser or another device all get
the same answer. The seed is the password digest unless `seed` is set, so **a
new password is a new calendar**, and a `seed` reshuffles it without touching
the password.

**The month.** Each month has *working days* (the password works that day) and
*off days*:

| week | days | working days |
|---|---|---|
| 1 | 1–7 | 4 |
| 2 | 8–14 | 3 |
| 3 | 15–21 | 3 |
| 4 | 22–end of month (29–31 included) | 2 |

Which days are picked never settles into a pattern: at most two working days in
a row (never three — also across weeks and months), no evenly spaced days inside
a week (no 1-3-5-7, no 9-11-13), no four evenly spaced working days anywhere in
the month, and two neighbouring weeks never reuse the same weekdays.

**The day.** Every day hands 20 % of its hours (288 minutes) to the other side:

- a **working day** has 288 minutes of *blackout*, when the password fails;
- an **off day** has 288 minutes of *windows*, the only time the password works.

Those minutes are scattered into 10–15 windows of 12–30 minutes each — **never
more than 30 minutes** — at least 30 minutes apart and never touching midnight,
so two days can never merge into one long window. Where they fall is weighted
by the time of day: blackouts prefer the evening and access windows prefer
waking hours, so the library is least available when it is most tempting.

### What the visitor sees

- The gate says whether the library is **open** or **closed right now**, and
  keeps that line true while it is on screen.
- The right password at the wrong time is answered calmly — *"That's the right
  passcode, but the library is closed right now — it opens again later today"*
  — with only a coarse hint (within the hour / in a few hours / later today /
  tomorrow), enough to stop refreshing, not enough to plan around.
- Inside the app, when the current window closes, a countdown toast gives the
  grace (default 5 minutes) to finish, then playback pauses and the gate comes
  back as **"Closing time."** The password works again when the next window
  opens. A closed laptop lid or a background tab cannot stretch a window: the
  clock is re-read on every return and an overdue grace locks immediately.

### Honesty

The calendar runs on the **device clock, in the device's time zone**. It is a
commitment device, not a security boundary: whoever controls the clock controls
the calendar, and the schedule can always be previewed with `npm run site:hours`.
A local `file://` copy never has a site password, so it has no opening hours
either.

---

## 3. Deploy to Vercel

**From the dashboard:** import the repository → *Framework Preset: Other* →
*Build Command: (leave empty)* → *Output Directory: (leave empty / `.`)*.
`vercel.json` adds security headers and configures the optional library function;
it does not add a frontend build step. Vercel automatically deploys `api/library.js`
as a Node.js function.

**From the CLI:**

```bash
npm i -g vercel
vercel            # preview
vercel --prod     # production
```

The app then lives at `https://<project>.vercel.app`. Every deployment URL is
its own origin, so a PIN set in one of them does not exist in another — that
is exactly why the site password is a separate, deployment-wide thing.

**Any other static host** (Netlify, Cloudflare Pages, GitHub Pages, S3, nginx)
works the same way: upload the folder, serve `index.html` at the root. Only
`file://` and `https://` are supported (the app fetches `data/x-posts.json`
and `data/r-posts.json` over http and never over `file://`; on `file://` use
Import instead).

---

## 4. What the site password does and does not protect

The gate lives in the browser: it hashes what the visitor types and compares it
with the digest in `site.config.js`. It stops casual visitors, and it keeps
the app from booting (or fetching the dataset) before the password is typed.

**It does not protect the static files.** On a static host every file is a
public URL, so anybody who knows the path can fetch `data/x-posts.json` directly
— the prompt never runs for them. If that matters, do one of these:

1. **Keep the export out of the deployment.** `data/x-posts.json` is your real
   bookmark dump, and `data/r-posts.json` (Reddit saves) is private too; if either
   is committed, the deployment publishes it. Add it to
   `.vercelignore` (CLI deploys) or to your repo's ignore rules, and import the
   file in the browser instead (drag & drop it on the Import screen).
2. **Use a real server-side gate.** On Vercel: *Settings → Authentication* for
   production deployments, *Deployment Protection* for preview deployments, or
   a Firewall/WAF Basic-Auth rule. These protect the static files too,
   because the request never reaches the CDN without the password.
3. **Treat the URL as the secret.** If the dataset is small and personal, a
   long random URL is a poor-man's password.

Remember that anything already committed to git is in the history: rotating a
password does not un-publish an export that was pushed before.

---

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| The site opens without asking | `site.config.js` has an empty `hash`, or the change was not redeployed. Run the CLI again, redeploy, hard-reload (Ctrl/Cmd+Shift-R). |
| The prompt asks for the wrong password | The digest in `site.config.js` is for a different password. Re-run `npm run site:password -- "…"` and redeploy. |
| The prompt never appears although a hash is set | `site.config.js` was not published (check `https://<your-site>/site.config.js` in the browser — it must show a `hash`). |
| The visitor is asked again after every reload | Expected: nothing about the unlock is stored, so each load asks for the password. |
| The right password is refused with "the library is closed right now" | Opening hours are on (`availability.enabled: true` in `site.config.js`). Check the calendar with `npm run site:hours`; switch it off with `npm run site:password -- --hours off` and redeploy. |
| The app locked itself with "Closing time." | The current window ended and the grace ran out. The password works again when the next window opens — `npm run site:hours` shows when. |
| The calendar changed after I rotated the password | Expected: without a `seed`, the calendar is derived from the password digest. Set `--seed "…"` to pin it independently of the password. |
| The PIN I set locally is not asked on the site | Expected: the PIN lives in the local browser, the site password is the deployment-wide one. |
| The app is blank / a red error page | A file failed to load — the error page names the file and line. Check the deploy log and that `src/`, `styles/`, `vendor/` and `site.config.js` were all published. |

---

## 6. The local copy stays untouched

`site.config.js` with an empty `hash` is the default that ships in the repo, so
double-clicking `index.html` keeps working exactly as before: no prompt, no
network, no server.

---

## 6. Installable app (Android home screen)

The repo ships a web app manifest (`manifest.webmanifest`) and maskable icons in
`assets/icons/`. Serve the folder over **HTTPS** and serve `.webmanifest` as
`application/manifest+json` (Vercel, Netlify and GitHub Pages do this already).
Chrome on Android will then offer *Install app* / *Add to Home screen*, opening
standalone with the `#141414` theme colour and the red-X icon.

The manifest is inert on `file://`; the app itself still runs there.


---

## 7. Permanent “Delete from library” (shared across browsers)

**Hide from library** remains a reversible, per-browser preference. **Delete from
library** is different: it removes the post's row from the repository's data file,
and records its ID in `data/deleted-posts.js`. Both changes are published in **one
atomic Git commit**. Concurrent edits are retried without force-pushing.

A browser cannot rewrite static hosting files, and writing a file inside a Vercel
function would be temporary. This implementation instead writes to a deliberately
configured repository and branch via the GitHub API. **It is not enabled merely
by deploying the frontend.** Until configured, the menu explains the requirement
and does not pretend to delete or fall back to hiding.

### One-time Vercel setup

In the project's **Settings → Environment Variables**, configure these as
**server-only secrets/settings** for the appropriate deployment environment:

| Variable | Value |
|---|---|
| `LIBRARY_GITHUB_TOKEN` | A fine-grained server-side GitHub token restricted to the library repository, with **Contents: Read and write**. Never put it in frontend code, `site.config.js`, or chat. |
| `LIBRARY_GITHUB_REPOSITORY` | Repository containing the live dataset, in `owner/repository` form. |
| `LIBRARY_GITHUB_BRANCH` | Exact branch that owns the live dataset. Set explicitly; no implicit default. It must permit the function's commits. |
| `LIBRARY_DELETE_PASSWORD` | A separate strong deletion password, **at least 16 characters**. You enter this in the app when confirming deletion; the server verifies it. It is not the browser PIN or the public site-password hash. |
| `LIBRARY_DATA_PATH` | Optional; defaults to `data/x-posts.json`. Set `data/posts.js` if that is the actual source. Only these two paths are accepted. The file was called `data/posts.json` before; if you set that path explicitly, change it to `data/x-posts.json`. Reddit posts in `data/r-posts.json` cannot be deleted through this server. |

Then **redeploy**. Use a supported Node.js runtime (Node 22 recommended). Keep
`api/library.js` and `server/library-store.cjs` in the deployment. Configure
Vercel's Git integration to redeploy when the selected data branch changes, so
static copies of the dataset and ledger also catch up. There is no automatic
change to your repository settings, branch protections or hosting secrets.

Scope production credentials to **Production**, not all previews. The function
also refuses a preview configured to write to a branch other than that preview's
`VERCEL_GIT_COMMIT_REF`. For a writable preview, use an isolated test repository/
branch with synthetic data and matching preview-only settings. Do not test
permanent deletion against your real dataset unless you intend to remove a post.
If the branch requires pull requests or rejects direct commits, the operation
fails safely; supply a suitable permitted data branch/workflow instead.

### What happens when you delete

1. Open a post's **More → Delete from library**.
2. Read the warning and enter the deletion password. **Cancel** changes nothing.
3. The server removes every matching top-level row from the configured data file,
   updates its count, drops the now-stale export verification report, and adds
   the ID to the shared deletion ledger. It never executes imported JavaScript.
4. Only after the durable write succeeds does this browser remove the post from
   the catalog and its cached libraries. An open Viewer closes; Watch returns to
   Library so the removed post does not keep playing.
5. On each subsequent load, library switch, or import, browsers read the current
   shared ledger **before** using static data or caches. This stops a stale
   deployment or reimported old export from making deleted IDs visible again,
   even before the redeploy finishes. The API response is never cached. If a
   configured API cannot be read, the app shows a data error rather than silently
   displaying an older library. Already-open tabs should reload to see deletions
   made elsewhere; there is no live push sync.

The public status endpoint returns only `{ enabled, deletedIds }`, never the
password, token, or full export. DELETE requires a JSON request and the deletion
password, and rejects cross-origin browser requests. Use HTTPS, a strong password,
and hosting firewall/rate limits for internet-facing deployments. The existing
client-side site gate is **not** server authorization.

### Limits and recovery

- Only posts actually present in the **shared configured data file** can be
  deleted this way. A post existing solely in a private browser import is not in
  that file; the server reports that and does not falsely claim a shared delete.
- Other static hosts and `file://` can read the ledger shipped with their copy,
  but cannot perform shared deletion without hosting the same API. Old offline
  copies cannot learn future deletions until updated. A download/export is not
  silently substituted for a server write.
- Keep `data/deleted-posts.js` when replacing exports or redeploying. It is the
  shared safeguard against resurrection. Do not replace it with an older empty
  file. A future export may contain a deleted row on disk, but the app filters
  its ID again on import; the delete operation itself removes the row on disk.
- This removes the current library record, **not** the original X post, your X
  bookmark, remote media files, old Git commits, or previously published static
  URLs. Git history is not secure erasure. There is no in-app Undo; an owner can
  deliberately restore from history and edit the ledger outside the app.
- A failed or uncertain network response never turns into a local hide. Reload
  to reconcile the ledger, or retry: deleting an already-removed ID is safe.

### Regression checks (synthetic data only)

```bash
npm ci
npm run check
npm run test:unit
IMPECCABLE_BROWSER=/path/to/chrome npm run test:ui
```

Server tests simulate the Git API and atomic ref updates; importer tests cover
cached/imported datasets and reimports. Browser tests use an isolated synthetic
endpoint and independent browser contexts, and do not mutate your live data.
