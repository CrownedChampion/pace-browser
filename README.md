# Pace Browser

**Browse at the speed of thought.**
A fast, private desktop browser for Windows x64. Developed by **That1Dev**.

---

## ⚖️ This is not an open-source project

Pace Browser is **proprietary, closed-source software**. This repository exists to host
official **releases**, **documentation**, and **issue tracking** — it does **not** grant a license
to use, copy, modify, redistribute, or build the source code. The application is free to download
and use; the code itself is not open source.

© That1Dev. All rights reserved.

---

## ⬇️ Install

Download the latest **`Pace-Browser-Setup.exe`** from the [Releases](../../releases) page and run it.
Pace updates itself automatically when a new version is published.

---

## 🧩 Pace Addons (not Chrome extensions)

Pace does **not** run Chrome extensions. Modern extensions are Manifest V3 and keep their core logic
in a background **service worker**, which cannot run on Pace's Electron engine — so they only ever
half-loaded. Instead, Pace has its own native addon format: the **Pace Addon**.

Manage and install addons from **`pace://extensions`** (the Pace Addon Shop), or browse reviewed
addons at **paceaddonshop.thestripedfox.workers.dev**. Addons installed from outside the official Shop
show a security warning first.

## 👩‍💻 Developer guide — building a Pace Addon

A Pace Addon is a folder with an `addon.json` manifest. The browser drives it directly, so there is
**no service worker** to fight. Three capabilities are supported today: cosmetic CSS, content scripts,
and network block rules.

**Folder layout**
```
my-addon/
├── addon.json
├── content.js   (optional)
├── style.css    (optional)
└── icon.png     (optional)
```

**addon.json**
```json
{
  "id": "my-addon",
  "name": "My Addon",
  "version": "1.0.0",
  "description": "What it does.",
  "author": "You",
  "permissions": ["cosmetic", "content", "network"],
  "matches": ["<all_urls>"],

  "hide": [".some-banner", "#promo"],

  "block": ["/ads/", "/sponsor/"],
  "block_hosts": ["tracker.example.com"],

  "content_scripts": [
    { "matches": ["*://*.example.com/*"], "js": ["content.js"], "css": ["style.css"], "run_at": "document_idle" }
  ]
}
```

**What each field does**
- `matches` — which pages the addon applies to. `"<all_urls>"` means every http(s)/file page; you can
  also use globs like `"*://*.example.com/*"`.
- `hide` — CSS selectors to hide (the element is collapsed with `display:none`). Great for cosmetic
  ad/element blocking.
- `block` — URL substrings to block at the network level (third-party requests only, so a site's own
  resources are never blocked).
- `block_hosts` — hostnames to block (matches the host and its subdomains, third-party only).
- `content_scripts` — JavaScript/CSS injected into matching pages. `content.js` runs in the page and
  can read and modify the DOM.

**content.js example**
```js
// Runs on every matching page.
document.querySelectorAll('.newsletter-popup').forEach(el => el.remove());
```

**Install it:** `pace://extensions` → **Install from folder…** → pick the addon folder. (You'll get a
security prompt because it's outside the official Shop — that's expected for local installs.)

> Coming next: background pages (a real persistent page, not a service worker) and toolbar popups.
> These manifest fields (`background`, `popup`) are reserved and read today, but not yet executed.


## 📬 Contact

Questions, bug reports, or extension-developer questions: **cbusinessact@proton.me**
