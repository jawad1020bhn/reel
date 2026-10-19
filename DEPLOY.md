# Deploying XReels (Vercel & friends)

XReels is a **static site**: no build step, no server, no framework. Deploy the
folder as-is and it runs.

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

## 3. Deploy to Vercel

**From the dashboard:** import the repository → *Framework Preset: Other* →
*Build Command: (leave empty)* → *Output Directory: (leave empty / `.`)*.
`vercel.json` in the repo only adds security headers, it does not change the
build.

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
`file://` and `https://` are supported (the app fetches `data/posts.json`
over http and never over `file://`).

---

## 4. What the site password does and does not protect

The gate lives in the browser: it hashes what the visitor types and compares it
with the digest in `site.config.js`. It stops casual visitors, and it keeps
the app from booting (or fetching the dataset) before the password is typed.

**It does not protect the static files.** On a static host every file is a
public URL, so anybody who knows the path can fetch `data/posts.json` directly
— the prompt never runs for them. If that matters, do one of these:

1. **Keep the export out of the deployment.** `data/posts.json` is your real
   bookmark dump; if it is committed, the deployment publishes it. Add it to
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
