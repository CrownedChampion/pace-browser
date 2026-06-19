# Pace Browser
**Browse at the speed of thought.**  
Developed by That1Dev · v1.0.0 · Windows x64

---

## Build Instructions

> **Important:** Use Node.js **16.20.2** for best compatibility.  
> Switch with nvm: `nvm install 16.20.2 && nvm use 16.20.2`

### One-click build
```powershell
.\BUILD.ps1
# → outputs dist/Pace Browser Setup 1.0.0.exe
```

### Dev mode (no installer)
```powershell
.\BUILD.ps1 -DevMode
```

### Manual
```bash
npm install
npm run build      # build installer
npm start          # run without building
```

### Before building — replace the icon
Place a proper **256×256 Windows .ico** file at:
```
src/assets/icons/icon.ico
```
Free converter: [icoconvert.com](https://icoconvert.com)

---

## Features

| Feature | Description |
|---|---|
| ⚡ Fast Mode | Pre-loads pages as you type — pages appear instantly |
| 🎵 Sidebar Apps | Spotify, Discord, Reddit, Gmail + 8 more in a bubble-animated panel |
| 🔍 Search Engine | Google, Bing, DuckDuckGo, Brave, Ecosia — synced across toolbar + new tab |
| 🛡 Ad Blocker | Configurable keyword-based request blocking |
| ⬇ Download Manager | Progress tracking, open file, show in folder |
| 🧩 Extensions | Install from Chrome Web Store URLs or .crx files |
| 🌙 Dark / Light Mode | Full theme switching with accent color picker |
| 🪶 Light Resources | Reduces RAM/CPU/storage usage |
| 📜 History | Searchable history at pace://history |
| ⌨ Tab Autocomplete | Press Tab to complete URLs in address bar |
| 🔍 Hover Preload | Hovering a suggestion in Fast Mode triggers background preload |
| 🗂 Pace Pages | pace://newtab · pace://settings · pace://downloads · pace://extensions · pace://history |

---

## File Structure

```
pace-browser/
├── src/
│   ├── main/main.js              Main process — tabs, Fast Mode, IPC, downloads
│   ├── preload/preload.js        Secure IPC bridge (contextBridge)
│   ├── preload/pagePreload.js    Minimal page preload
│   └── renderer/
│       ├── index.html            Browser chrome — tabs, toolbar, sidebar, address bar
│       ├── newtab.html           New tab with search + engine picker + clock
│       ├── settings.html         Full settings — theme, search, ad block, accent color
│       ├── extensions.html       Extension manager
│       ├── downloads.html        Download history page
│       ├── history.html          Browsing history
│       ├── tos.html              Terms of Service
│       └── privacy.html          Privacy Policy
├── BUILD.ps1                     One-click build script
├── package.json                  npm + electron-builder config
└── docs/LICENSE.txt              EULA shown during install
```

---

Pace Browser · Developed by That1Dev
