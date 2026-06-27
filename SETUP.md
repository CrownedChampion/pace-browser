# Pace Browser — Setup, Releasing & Website Deployment

## 1. Build the browser locally

```bash
npm install          # REQUIRED — pulls electron, electron-builder,
                     # electron-chrome-web-store, and electron-updater
npm start            # run in dev
npm run build        # produce the Windows installer in /dist
```

> `npm install` is mandatory before the first build — the Chrome Web Store
> support and the auto-updater are npm dependencies.

---

## 2. One-time placeholders to fill in

| File | Placeholder | Replace with |
|------|-------------|--------------|
| `electron-builder.yml` | `YOUR_GITHUB_USERNAME` | your GitHub username *(optional — the release workflow sets this automatically, see §3)* |
| `website/index.html` | `YOUR_GITHUB_USERNAME` (download link) | your GitHub username |
| `website/index.html` | `YOUR_WEB3FORMS_ACCESS_KEY` | your Web3Forms key (see §5) |
| `website/index.html` | `YOUR_KOFI` / `YOUR_GITHUB_USERNAME` (donate) | your Ko‑fi handle / Sponsors username, or delete the buttons |

---

## 3. Releasing updates (auto-version + auto-update)

The browser checks for updates on launch, downloads them in the background, and
installs on quit. To ship a new version:

```bash
git tag v1.0.1
git push origin v1.0.1
```

That's it. The GitHub Action (`.github/workflows/release.yml`):
1. **Sets the app version from the tag** (`v1.0.1` → `1.0.1`) — you never edit the version by hand.
2. Auto-fills the updater's repo so installed copies look in the right place.
3. Builds the Windows installer and publishes it + `latest.yml` to the GitHub Release.

Installed browsers compare their version to `latest.yml` and update themselves.

**Prerequisite:** push this repo to GitHub. The workflow uses the built-in
`GITHUB_TOKEN`, so no extra secrets are needed for publishing.

You can also publish manually from your own machine:

```bash
# set a GitHub token with repo scope first
set GH_TOKEN=ghp_xxx        # Windows
npm version 1.0.1 --no-git-tag-version
npm run release
```

---

## 4. Deploy the website to Cloudflare Pages (via GitHub)

The site lives in `website/` (static HTML — no build step).

1. Push this repo to GitHub.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
3. Pick the repo, then set:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `website`
4. **Save and Deploy.** Every push to the repo redeploys automatically.
5. (Optional) Add your custom domain under the Pages project's **Custom domains** tab.

---

## 5. Make the "Request a feature" form send to your email

The form posts to **Web3Forms** (free, works on static hosting):

1. Go to <https://web3forms.com>, enter **cbusinessact@proton.me**, and copy the **Access Key** they email you.
2. In `website/index.html`, replace `YOUR_WEB3FORMS_ACCESS_KEY` with that key.

Submissions then arrive at cbusinessact@proton.me. Until the key is set, the form
shows a message telling visitors to email you directly (there's also a mailto link).

---

## 6. What ships in the installer

- File associations: `.html`, `.htm`, `.xhtml`, `.svg` open in Pace (double-click works once installed).
- Default-browser prompt appears on first launch; "Make default" also lives in **Settings → Default browser & updates**.
- Auto-update + manual "Check for updates" in the same settings section.

> Note: Auto-update only runs in the **installed** app (not `npm start`), and the
> default-browser switch on Windows 10/11 opens the system "Default apps" page for
> final confirmation (an OS requirement).
