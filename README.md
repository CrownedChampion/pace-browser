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

## 🧩 Extensions in Pace

Pace is built on Electron, not on Chromium directly. That has one important consequence you should
understand before building or installing extensions:

- ✅ **What works well:** extensions whose features run as **content scripts** (ad/content blockers,
  page restylers, dark-mode tools, on-page widgets) or in a **popup**. These are fully supported.
- ⚠️ **What is limited:** most modern **Manifest V3** extensions keep their core logic in a
  background **service worker**. Electron's support for extension service workers is incomplete, so
  an MV3 extension that depends on its background may fail to load or only partly work.
- ❌ **What does not work:** Chrome-only APIs such as `chrome.tabCapture`, and anything that needs a
  always-running background service worker.

There is **no Chrome Web Store** in Pace. You add extensions by loading an **unpacked folder**.

### Installing an extension
1. Open **`pace://extensions`** (Menu → Extensions).
2. Click **Load Unpacked**.
3. Select a folder that contains a `manifest.json`.

The extension loads immediately and is re-loaded automatically on every launch.

---

## 👩‍💻 Developer guide — building an extension that works in Pace

The most reliable extensions for Pace are **content-script** and **popup** based. Here is a minimal
working example.

**Folder layout**
```
my-extension/
├── manifest.json
├── content.js
└── popup.html
```

**manifest.json**
```json
{
  "manifest_version": 3,
  "name": "My Pace Extension",
  "version": "1.0.0",
  "description": "Does something useful on web pages.",
  "permissions": ["activeTab", "storage"],
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "action": { "default_popup": "popup.html" }
}
```

**content.js** (runs on every page — this is the part Pace runs reliably)
```js
// Example: add a small badge to every page.
const badge = document.createElement('div');
badge.textContent = 'Loaded in Pace';
badge.style.cssText =
  'position:fixed;bottom:12px;right:12px;z-index:2147483647;padding:6px 10px;' +
  'background:#5b8ef0;color:#fff;border-radius:8px;font:12px sans-serif';
document.body.appendChild(badge);
```

**popup.html**
```html
<!doctype html>
<html><body style="width:220px;font:14px sans-serif;padding:12px">
  <h3>My Pace Extension</h3>
  <p>Popup UI goes here.</p>
</body></html>
```

### Guidelines for reliability
- **Do** put your logic in `content_scripts` and/or the popup.
- **Do** use `chrome.storage` and `chrome.runtime` messaging between popup and content scripts.
- **Avoid** relying on a background **service worker** for core behaviour — it may not run.
- **Avoid** `chrome.tabCapture`, `chrome.debugger`, and other Chrome-only/privileged APIs.
- **Test in Pace**, not just Chrome — if it changes pages, it'll almost certainly work; if it needs
  a persistent background, verify before shipping.

> A first-party **Pace Addon** format (designed to run natively, with no service-worker limitations)
> is planned. When it ships, this guide will be updated with the new format.

---

## 📬 Contact

Questions, bug reports, or extension-developer questions: **cbusinessact@proton.me**
