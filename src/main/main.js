const { app, BrowserWindow, BrowserView, ipcMain, protocol, session, shell, Menu, MenuItem, dialog, clipboard, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
// electron-chrome-web-store uses the Web Crypto API (crypto.subtle) to verify CRX signatures.
// Electron's older Node (18) doesn't expose `crypto` as a global, so map it to Node's webcrypto.
try { if (typeof globalThis.crypto === 'undefined') globalThis.crypto = require('crypto').webcrypto; } catch (e) {}
// Some Electron builds don't expose WebFrameMain.isDestroyed(), which electron-chrome-web-store calls.
// Polyfill it so the Web Store integration doesn't throw "senderFrame.isDestroyed is not a function".
try {
  const { WebFrameMain } = require('electron');
  if (WebFrameMain && WebFrameMain.prototype && typeof WebFrameMain.prototype.isDestroyed !== 'function') {
    WebFrameMain.prototype.isDestroyed = function () { return false; };
  }
} catch (e) {}
// Purpose-built Chrome Web Store support for Electron (download + CRX verify + install + reload).
// Loaded defensively so the app still launches if the dependency isn't installed yet.
let webStore = null;
try { webStore = require('electron-chrome-web-store'); } catch (e) { webStore = null; }
// Optional: electron-chrome-extensions implements the chrome.tabs / chrome.windows APIs so
// extensions that open their own tabs work. It needs a native-ish install (npm install
// electron-chrome-extensions); if absent we fall back to the window-open handler below.
let ElectronChromeExtensions = null;
try { ElectronChromeExtensions = require('electron-chrome-extensions').ElectronChromeExtensions; } catch (e) { ElectronChromeExtensions = null; }
let chromeExtensions = null;   // instance, created after the window exists
// Auto-update via GitHub Releases (electron-updater). Defensive so dev runs without it still work.
let autoUpdater = null;
let updateDownloadedVersion = null;   // set when an update finishes downloading this session
try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { autoUpdater = null; }

// ── Single instance + opening web files/links passed by the OS ──────────────────
let pendingOpenUrl = null;
function argToUrl(argv) {
  try {
    for (const a of (argv || []).slice(1)) {
      if (!a || a.startsWith('--') || a.startsWith('pace:')) continue;
      if (/^https?:\/\//i.test(a)) return a;
      if (/^file:\/\//i.test(a)) return a;
      if (fs.existsSync(a) && fs.statSync(a).isFile()) return 'file://' + path.resolve(a).replace(/\\/g, '/');
    }
  } catch (e) {}
  return null;
}
function openInBrowser(url) {
  if (!url) return;
  if (typeof mainWindow !== 'undefined' && mainWindow) { try { createTab(url); if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } catch (e) {} }
  else pendingOpenUrl = url;
}
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) { app.quit(); }
else {
  app.on('second-instance', (e, argv) => { const u = argToUrl(argv); if (u) openInBrowser(u); else if (typeof mainWindow !== 'undefined' && mainWindow) { try { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } catch (_) {} } });
  app.on('open-file', (e, p) => { e.preventDefault(); openInBrowser('file://' + p.replace(/\\/g, '/')); }); // macOS
  pendingOpenUrl = argToUrl(process.argv);
}
// Register as a handler for web links so Pace can be chosen as the default browser.
try { app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https'); } catch (e) {}

// ─── Performance flags (must run before app ready) ──────────────────────────────
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-smooth-scrolling');
app.commandLine.appendSwitch('autoplay-policy', 'user-gesture-required');
app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization,ParallelDownloading,SmoothScrolling');
// Disable the passkey "autofill" prompt (conditional WebAuthn UI) that Chromium pops while you
// type into a login field — this is an ENGINE feature, so it must be turned off here, not in JS.
// Explicit "Sign in with a passkey" buttons still work; only the auto-prompt-while-typing is gone.
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors,WebAuthenticationConditionalUI,WebAuthenticationNewBleTransport');
// Allow extensions (Shazam etc.) to capture tab audio and use getUserMedia without a fake-UI prompt.
app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
app.commandLine.appendSwitch('allow-http-screen-capture');

// IMPORTANT: the UA version must MATCH the real engine. Electron 28 = Chromium 120, so we claim
// Chrome 120 — not a higher number. Google's sign-in probes for JS features that should exist in
// the claimed version; claiming a version the engine can't back up (e.g. 131) is exactly what
// triggers "this browser may not be secure". Matching the true engine version avoids that mismatch.
const CHROME_VERSION = '120.0.0.0';
const CHROME_MAJOR = '120';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + CHROME_VERSION + ' Safari/537.36';
app.userAgentFallback = CHROME_UA;

// ─── Paths ─────────────────────────────────────────────────────────────────────
const userDataPath   = app.getPath('userData');
const settingsPath   = path.join(userDataPath, 'settings.json');
const historyPath    = path.join(userDataPath, 'history.json');
const bookmarksPath  = path.join(userDataPath, 'bookmarks.json');
const downloadsPath  = path.join(userDataPath, 'downloads.json');
const extensionsPath = path.join(userDataPath, 'extensions.json');
const faviconsPath   = path.join(userDataPath, 'favicons.json');
const vaultPath      = path.join(userDataPath, 'vault.json');

const RENDERER = (f) => path.join(__dirname, '../renderer', f);

// ─── Favicon cache (persisted so icons load once, then come from disk) ──────────
let faviconCache = {};
try { if (fs.existsSync(faviconsPath)) faviconCache = JSON.parse(fs.readFileSync(faviconsPath, 'utf8')); } catch (e) { faviconCache = {}; }
let faviconSaveTimer = null;
function persistFavicons() {
  clearTimeout(faviconSaveTimer);
  faviconSaveTimer = setTimeout(() => { try { fs.writeFileSync(faviconsPath, JSON.stringify(faviconCache)); } catch (e) {} }, 800);
}
function fetchFaviconData(domain) {
  return new Promise((resolve) => {
    try {
      const url = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(domain) + '&sz=64';
      const req = net.request(url);
      const chunks = [];
      req.on('response', (res) => {
        let ct = res.headers['content-type'] || 'image/png';
        if (Array.isArray(ct)) ct = ct[0];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          try { resolve('data:' + ct + ';base64,' + Buffer.concat(chunks).toString('base64')); }
          catch (e) { resolve(''); }
        });
      });
      req.on('error', () => resolve(''));
      req.end();
    } catch (e) { resolve(''); }
  });
}
function readBookmarks() {
  try { if (fs.existsSync(bookmarksPath)) return JSON.parse(fs.readFileSync(bookmarksPath, 'utf8')); } catch (e) {}
  // If the main file is missing/corrupt, try the backup before giving up.
  try { if (fs.existsSync(bookmarksPath + '.bak')) return JSON.parse(fs.readFileSync(bookmarksPath + '.bak', 'utf8')); } catch (e) {}
  return [];
}
// Atomic, guarded write: never overwrite a non-empty file with an empty/invalid array,
// keep a .bak of the last good state, and write via temp+rename so a crash can't truncate it.
function writeBookmarks(b) {
  if (!Array.isArray(b)) return false;
  try {
    const prev = readBookmarks();
    // Guard: if we currently have bookmarks and the incoming list is empty, treat as suspicious and skip
    // (real "clear all" goes through clearBookmarks() which bypasses this guard intentionally).
    if (Array.isArray(prev) && prev.length > 0 && b.length === 0) return false;
    const data = JSON.stringify(b, null, 2);
    const tmp = bookmarksPath + '.tmp';
    fs.writeFileSync(tmp, data);
    try { if (fs.existsSync(bookmarksPath)) fs.copyFileSync(bookmarksPath, bookmarksPath + '.bak'); } catch (e) {}
    fs.renameSync(tmp, bookmarksPath);
    return true;
  } catch (e) { return false; }
}
function clearBookmarks(scope) {
  // scope: 'all' | 'bar' | 'other'
  try {
    let b = readBookmarks();
    if (scope === 'bar') b = b.filter(x => x.folder === 'other');
    else if (scope === 'other') b = b.filter(x => x.folder !== 'other');
    else b = [];
    const data = JSON.stringify(b, null, 2);
    const tmp = bookmarksPath + '.tmp';
    fs.writeFileSync(tmp, data);
    try { if (fs.existsSync(bookmarksPath)) fs.copyFileSync(bookmarksPath, bookmarksPath + '.bak'); } catch (e) {}
    fs.renameSync(tmp, bookmarksPath);
    return b;
  } catch (e) { return readBookmarks(); }
}

// ─── Defaults ──────────────────────────────────────────────────────────────────
const defaultSettings = {
  fastMode: true,
  preloadCount: 6,
  theme: 'dark',
  searchEngine: 'google',
  searchEngines: {
    google:     'https://www.google.com/search?q=',
    bing:       'https://www.bing.com/search?q=',
    duckduckgo: 'https://duckduckgo.com/?q=',
    brave:      'https://search.brave.com/search?q=',
    ecosia:     'https://www.ecosia.org/search?q=',
    startpage:  'https://www.startpage.com/sp/search?query=',
  },
  homePage: 'pace://newtab',
  adBlock: true,
  adBlockFilters: ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com', 'adservice.google.com', 'pagead2.googlesyndication.com', 'adnxs.com', 'scorecardresearch.com', 'adsystem.com', 'amazon-adsystem.com', 'adsrvr.org', 'rubiconproject.com', 'pubmatic.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'casalemedia.com', 'openx.net', 'moatads.com', 'serving-sys.com', 'advertising.com', 'yieldmo.com', 'sharethrough.com', 'bidswitch.net', 'adform.net', '2mdn.net', 'zedo.com', 'bluekai.com', 'demdex.net', 'krxd.net', 'quantserve.com', 'ads.yahoo.com', 'ads.linkedin.com', 'analytics.tiktok.com'],
  httpsOnly: false,
  clearOnExit: false,
  animations: true,
  glassStrength: 'medium',
  lightResources: false,
  accentColor: '#5b8ef0',
  accentColor2: '#a78bfa',
  fontSize: 'medium',
  wallpaper: '',
  sidebarApps: ['spotify', 'youtube-music', 'discord'],
  quickLinks: [
    { n: 'Google',    u: 'google.com',    i: '🔍' },
    { n: 'YouTube',   u: 'youtube.com',   i: '▶️' },
    { n: 'GitHub',    u: 'github.com',    i: '🐙' },
    { n: 'Reddit',    u: 'reddit.com',    i: '🧡' },
    { n: 'X',         u: 'x.com',         i: '✖️' },
    { n: 'Netflix',   u: 'netflix.com',   i: '🎬' },
    { n: 'Wikipedia', u: 'wikipedia.org', i: '📖' },
    { n: 'Discord',   u: 'discord.com',   i: '💬' },
  ],
  sportsLeagues: ['nfl', 'nba'],
  sportsTeams: [],
  showSportsWidget: true,
  showClockWidget: true,
  toolbarButtons: { downloads: true, extensions: true, apps: true, history: false },
  showBookmarksBar: true,
  pinnedExtensions: [],
  autofill: true,
  extensions: [],
  downloadPath: app.getPath('downloads'),
};

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath))
      return { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
  } catch (e) {}
  return { ...defaultSettings };
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2)); } catch (e) {}
}

// ─── History ───────────────────────────────────────────────────────────────────
function readHistory() {
  try { if (fs.existsSync(historyPath)) return JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch (e) {}
  return [];
}
function addToHistory(url, title) {
  if (!url || url.startsWith('file://') || url.startsWith('pace://') || url === 'about:blank') return;
  try {
    let h = readHistory();
    if (h[0] && h[0].url === url) { h[0].time = Date.now(); }
    else h.unshift({ url, title: title || url, time: Date.now() });
    if (h.length > 5000) h = h.slice(0, 5000);
    fs.writeFileSync(historyPath, JSON.stringify(h));
  } catch (e) {}
}

// ─── Downloads ─────────────────────────────────────────────────────────────────
let downloads = [];
try { if (fs.existsSync(downloadsPath)) downloads = JSON.parse(fs.readFileSync(downloadsPath, 'utf8')); } catch (e) {}
function saveDownloads() { try { fs.writeFileSync(downloadsPath, JSON.stringify(downloads, null, 2)); } catch (e) {} }

// ─── State ───────────────────────────────────────────────────────────────────
let mainWindow   = null;
let tabs         = {};      // tabId -> BrowserView
let tabMeta      = {};      // tabId -> { detached }
let preloadViews = {};      // normalizedUrl -> { view, time }
let sidebarView  = null;
let settingsView = null;
let activeTabId  = null;
let tabCounter   = 0;
let closedTabs   = [];      // stack of recently closed tab URLs (for reopen)
const CHROME_H   = 94;
// Thin, modern scrollbar injected into web pages (does not affect sites that style their own)
const THIN_SCROLLBAR_CSS = `
  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:rgba(140,140,170,.45);border-radius:8px;border:3px solid transparent;background-clip:content-box}
  ::-webkit-scrollbar-thumb:hover{background:rgba(140,140,170,.75);background-clip:content-box}
  ::-webkit-scrollbar-corner{background:transparent}
`;

// Cosmetic ad hiding — hides common ad containers/iframes by selector when ad-block is on.
// This complements network blocking (which stops the request) by removing leftover ad slots.
const AD_HIDE_CSS = `
  ins.adsbygoogle,
  iframe[src*="doubleclick"], iframe[src*="googlesyndication"], iframe[src*="/ads/"], iframe[id^="google_ads_"],
  iframe[id^="aswift_"], iframe[name^="google_ads_"], iframe[aria-label="Advertisement"],
  div[id^="div-gpt-ad"], div[id*="google_ads"], div[class*="adsbygoogle"],
  [class*="ad-banner"], [class*="ad_banner"], [class*="adbox"], [class*="ad-container"],
  [class*="sponsored-"], [data-ad-slot], [data-ad-client], [aria-label="Advertisement"],
  .taboola, [id^="taboola-"], [id^="outbrain_widget"], .OUTBRAIN,
  [id^="ad-"], [class^="GoogleActiveViewElement"]{
    display:none !important; visibility:hidden !important; height:0 !important; min-height:0 !important;
  }
`;

// ─── Ad block & HTTPS-only via webRequest ───────────────────────────────────────
// URL substrings that indicate ad/tracker requests regardless of host (covers first-party serving).
const AD_URL_PATTERNS = [
  '/pagead/', '/adsbygoogle', '/doubleclick', 'googlesyndication', 'googleadservices',
  '/gampad/', '/gpt/', '/adservice', '/ad_status', '/getads', '/adframe', '/ad_iframe',
  'adnxs.com', '/track?', '/pixel?', '/beacon', '/collect?', 'scorecardresearch',
  'amazon-adsystem', '/prebid', '/openrtb', '/banners/', '/sponsor', 'taboola.com', 'outbrain.com'
];
function applyNetworkRules() {
  const s = loadSettings();
  const ses = session.defaultSession;
  const filters = (s.adBlockFilters || []).map(f => f.toLowerCase()).filter(Boolean);
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let url = details.url;
    // HTTPS-only upgrade for top-level navigations
    if (s.httpsOnly && details.resourceType === 'mainFrame' && url.startsWith('http://')) {
      return callback({ redirectURL: url.replace(/^http:\/\//, 'https://') });
    }
    if (s.adBlock && details.resourceType !== 'mainFrame') {
      const lower = url.toLowerCase();
      let host = '';
      try { host = new URL(url).hostname.toLowerCase(); } catch (e) { host = ''; }
      // 1) hostname-based domain filters (user list)
      if (host) {
        for (const f of filters) {
          if (f.indexOf('.') !== -1) { if (host === f || host.endsWith('.' + f)) return callback({ cancel: true }); }
          else if (host.split('.').indexOf(f) !== -1) return callback({ cancel: true });
        }
      }
      // 2) full-URL pattern filters (catches first-party / path-based ads), but never block media or the page itself
      if (details.resourceType !== 'media') {
        for (const p of AD_URL_PATTERNS) { if (lower.indexOf(p) !== -1) return callback({ cancel: true }); }
        // user filters can also be path fragments (contain a slash) -> substring match
        for (const f of filters) { if (f.indexOf('/') !== -1 && lower.indexOf(f) !== -1) return callback({ cancel: true }); }
      }
    }
    callback({});
  });

  // Send the client-hint headers a real Chrome sends, and make sure no request carries an
  // "Electron"/app token. Google's sign-in inspects Sec-CH-UA; without it (or with Electron in
  // the UA) it refuses with "this browser or app may not be secure".
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const h = details.requestHeaders || {};
    // Force a clean Chrome UA on every request (covers popups/iframes, not just the main UA).
    if (h['User-Agent'] && /Electron|Pace/i.test(h['User-Agent'])) h['User-Agent'] = CHROME_UA;
    if (!h['User-Agent']) h['User-Agent'] = CHROME_UA;
    // Client hints (low-entropy set Chrome always sends), matched to the UA version above.
    h['sec-ch-ua'] = '"Not_A Brand";v="8", "Chromium";v="' + CHROME_MAJOR + '", "Google Chrome";v="' + CHROME_MAJOR + '"';
    h['sec-ch-ua-mobile'] = '?0';
    h['sec-ch-ua-platform'] = '"Windows"';
    callback({ requestHeaders: h });
  });
}
function readExtStore() {
  try { if (fs.existsSync(extensionsPath)) return JSON.parse(fs.readFileSync(extensionsPath, 'utf8')); } catch (e) {}
  return [];
}
function writeExtStore(list) {
  try { fs.writeFileSync(extensionsPath, JSON.stringify(list, null, 2)); } catch (e) {}
}

// ── Element blocker (user-picked elements to hide, saved per registrable domain) ──
const elementBlocksPath = path.join(userDataPath, 'element-blocks.json');
function readElementBlocks() {
  try { if (fs.existsSync(elementBlocksPath)) return JSON.parse(fs.readFileSync(elementBlocksPath, 'utf8')); } catch (e) {}
  return {};
}
function writeElementBlocks(obj) {
  try { fs.writeFileSync(elementBlocksPath, JSON.stringify(obj, null, 2)); } catch (e) {}
}
function blocksForHost(host) {
  try {
    const rd = registrableDomain(host);
    const all = readElementBlocks();
    return (rd && all[rd]) ? all[rd] : [];
  } catch (e) { return []; }
}
ipcMain.handle('element-block-add', (e, { host, selector }) => {
  try {
    if (!host || !selector) return { ok: false };
    const rd = registrableDomain(host);
    const all = readElementBlocks();
    all[rd] = all[rd] || [];
    if (!all[rd].includes(selector)) all[rd].push(selector);
    writeElementBlocks(all);
    return { ok: true };
  } catch (err) { return { ok: false }; }
});
ipcMain.handle('element-block-list', (e, { host }) => {
  return { ok: true, selectors: blocksForHost(host) };
});
ipcMain.handle('element-block-clear', (e, { host }) => {
  try { const rd = registrableDomain(host); const all = readElementBlocks(); delete all[rd]; writeElementBlocks(all); return { ok: true }; }
  catch (e) { return { ok: false }; }
});
// Tell the active tab to enter element-pick mode.
ipcMain.on('element-pick-start', () => {
  try { if (activeTabId && tabs[activeTabId]) tabs[activeTabId].webContents.send('pace-pick-element'); } catch (e) {}
});
async function loadStoredExtensions() {
  const list = readExtStore();
  for (const ext of list) {
    if (ext.enabled && ext.path && fs.existsSync(ext.path)) {
      try {
        const loaded = await session.defaultSession.loadExtension(ext.path, { allowFileAccess: true });
        ext.id = loaded.id; ext.runtimeName = loaded.name;
      } catch (e) { ext.error = String(e.message || e); }
    }
  }
  writeExtStore(list);
}

// ─── Extension enable/disable state (works for Web Store + unpacked) ─────────────
const extStatePath = path.join(userDataPath, 'extstate.json');
let extState = { disabled: [], meta: {} };
try { if (fs.existsSync(extStatePath)) extState = Object.assign(extState, JSON.parse(fs.readFileSync(extStatePath, 'utf8'))); } catch (e) {}
function saveExtState() { try { fs.writeFileSync(extStatePath, JSON.stringify(extState)); } catch (e) {} }
function extIconDataUrl(extPath, m) {
  try {
    if (!m || !extPath) return '';
    let rel = '';
    const icons = m.icons || (m.action && m.action.default_icon) || (m.browser_action && m.browser_action.default_icon) || (m.page_action && m.page_action.default_icon);
    if (typeof icons === 'string') rel = icons;
    else if (icons && typeof icons === 'object') {
      // prefer 48, then the largest available <=128, else any
      const keys = Object.keys(icons).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
      const pick = keys.find(n => n >= 32 && n <= 64) || keys.filter(n => n <= 128).pop() || keys.pop();
      if (pick != null) rel = icons[String(pick)];
    }
    if (!rel) return '';
    const p = path.join(extPath, rel.replace(/^\/+/, ''));
    if (!fs.existsSync(p)) return '';
    const ext = (path.extname(p).slice(1) || 'png').toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/' + ext;
    return 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64');
  } catch (e) { return ''; }
}
function syncExtMeta() {
  // Record path/name/version/icon for every currently-loaded extension (so disabled ones can be reloaded later)
  try {
    session.defaultSession.getAllExtensions().forEach(x => {
      const prev = extState.meta[x.id] || {};
      extState.meta[x.id] = {
        path: x.path, name: x.name, version: x.manifest && x.manifest.version,
        popup: extPopupPath(x.manifest), options: extOptionsPath(x.manifest),
        icon: extIconDataUrl(x.path, x.manifest) || prev.icon || ''
      };
    });
  } catch (e) {}
  saveExtState();
}
function extPopupPath(m) { if (!m) return ''; return (m.action && m.action.default_popup) || (m.browser_action && m.browser_action.default_popup) || (m.page_action && m.page_action.default_popup) || ''; }
function extOptionsPath(m) { if (!m) return ''; return (m.options_ui && m.options_ui.page) || m.options_page || ''; }
async function applyDisabledExtensions() {
  for (const id of extState.disabled) { try { session.defaultSession.removeExtension(id); } catch (e) {} }
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createMainWindow() {
  const settings = loadSettings();
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 940, minHeight: 620,
    frame: false,
    backgroundColor: settings.theme === 'light' ? '#eef1fb' : '#0b0b13',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/preload.js'),
      sandbox: false,
    },
    icon: path.join(__dirname, '../assets/icons/icon.ico'),
    show: false,
  });

  mainWindow.loadFile(RENDERER('index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // Create the first tab only once the renderer has attached its listeners (see 'chrome-ready'),
  // so the tab-created event is never lost to a startup race. Fallback in case that signal never arrives.
  mainWindow.webContents.on('did-finish-load', () => { setTimeout(ensureTab, 1500); });

  const sendState = () => mainWindow.webContents.send('window-state', { maximized: mainWindow.isMaximized() });
  mainWindow.on('maximize', sendState);
  mainWindow.on('unmaximize', sendState);
  Menu.setApplicationMenu(null);

  // Downloads
  mainWindow.webContents.session.on('will-download', (event, item) => {
    const s = loadSettings();
    const savePath = path.join(s.downloadPath || app.getPath('downloads'), item.getFilename());
    item.setSavePath(savePath);
    const dlId = Date.now().toString();
    const dl = { id: dlId, filename: item.getFilename(), url: item.getURL(), savePath, state: 'progressing', received: 0, total: item.getTotalBytes(), startTime: Date.now() };
    downloads.unshift(dl); saveDownloads();
    mainWindow.webContents.send('download-started', dl);
    item.on('updated', (e, state) => {
      dl.state = state; dl.received = item.getReceivedBytes(); dl.total = item.getTotalBytes();
      mainWindow.webContents.send('download-progress', { id: dlId, state, received: dl.received, total: dl.total });
      saveDownloads();
    });
    item.once('done', (e, state) => {
      dl.state = state; dl.received = item.getReceivedBytes();
      mainWindow.webContents.send('download-done', { id: dlId, state, savePath });
      saveDownloads();
    });
  });
}

// ─── Tab listeners (shared by new + adopted preload views) ──────────────────────
function attachTabListeners(view, tabId) {
  const wc = view.webContents;
  // Force a clean Chrome UA on this view (popups created from it inherit it too).
  try { wc.setUserAgent(CHROME_UA); } catch (e) {}
  wc.on('dom-ready', () => {
    const u = wc.getURL() || '';
    if (/^https?:|^file:/.test(u)) {
      wc.insertCSS(THIN_SCROLLBAR_CSS).catch(() => {});
      try { if (loadSettings().adBlock && /^https?:/.test(u)) wc.insertCSS(AD_HIDE_CSS).catch(() => {}); } catch (e) {}
      // Hide any elements the user blocked on this site.
      try {
        let host = ''; try { host = new URL(u).hostname; } catch (e) {}
        const sels = blocksForHost(host);
        if (sels && sels.length) wc.insertCSS(sels.join(',') + '{display:none !important}').catch(() => {});
      } catch (e) {}
    }
  });
  wc.on('did-start-loading', () => mainWindow.webContents.send('tab-loading', { tabId, loading: true }));
  wc.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
    if (isMainFrame && formatUrl(url || wc.getURL()).startsWith('pace://')) {
      mainWindow.webContents.send('tab-update', { tabId, favicon: '' });
    }
  });
  wc.on('did-stop-loading', () => {
    const u = wc.getURL(); const t = wc.getTitle() || u;
    mainWindow.webContents.send('tab-loading', { tabId, loading: false });
    mainWindow.webContents.send('tab-update', { tabId, url: formatUrl(u), title: t, canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() });
    addToHistory(u, t);
  });
  wc.on('page-title-updated', (e, title) => mainWindow.webContents.send('tab-update', { tabId, title }));
  wc.on('page-favicon-updated', (e, favs) => { if (favs && favs[0]) mainWindow.webContents.send('tab-update', { tabId, favicon: favs[0] }); });
  const navUpdate = (url) => mainWindow.webContents.send('tab-update', { tabId, url: formatUrl(url), canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() });
  wc.on('did-navigate', (e, url) => navUpdate(url));
  wc.on('did-navigate-in-page', (e, url) => navUpdate(url));
  wc.setWindowOpenHandler(({ url, disposition }) => {
    // Open popups, target=_blank links, and extension-created tabs (chrome-extension://) as real tabs.
    // Foreground when the page asked for a new foreground tab; background for new-window/background.
    const background = disposition === 'background-tab';
    if (url && url !== 'about:blank') createTab(url, background);
    return { action: 'deny' };
  });
  wc.on('context-menu', (e, params) => buildPageContextMenu(view, tabId, params));
  wireMedia(wc);
  // Browser shortcuts must work even while a web page (BrowserView) holds keyboard focus
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta, shift = input.shift, k = (input.key || '').toLowerCase();
    let handled = true;
    if (ctrl && shift && k === 't') reopenClosedTab();
    else if (ctrl && shift && k === 'b') mainWindow.webContents.send('app-shortcut', { action: 'toggle-bookmarks' });
    else if (ctrl && k === 't') createTab('pace://newtab');
    else if (ctrl && k === 'w') { if (activeTabId) closeTab(activeTabId); }
    else if (ctrl && (k === 'l')) { mainWindow.webContents.focus(); mainWindow.webContents.send('app-shortcut', { action: 'focus-address' }); }
    else if (ctrl && k === ',') mainWindow.webContents.send('app-shortcut', { action: 'settings' });
    else if (ctrl && k === 'd') mainWindow.webContents.send('app-shortcut', { action: 'bookmark' });
    else if ((ctrl && k === 'r') || k === 'f5') { if (tabs[activeTabId]) tabs[activeTabId].webContents.reload(); }
    else if (ctrl && k === 'tab') mainWindow.webContents.send('app-shortcut', { action: shift ? 'prev-tab' : 'next-tab' });
    else if (k === 'f11') { try { mainWindow.setFullScreen(!mainWindow.isFullScreen()); } catch (e) {} }
    else handled = false;
    if (handled) event.preventDefault();
  });
}

// ─── Media (now-playing title + controls) ───────────────────────────────────────
let mediaWC = null;
function readMediaMeta(wc) {
  const js = "(function(){try{var m=navigator.mediaSession&&navigator.mediaSession.metadata;var els=Array.prototype.slice.call(document.querySelectorAll('video,audio'));var t=(m&&m.title)?m.title:document.title;var a=(m&&m.artist)?m.artist:'';return {title:t,artist:a};}catch(e){return {title:document.title,artist:''};}})()";
  return wc.executeJavaScript(js, true).catch(() => ({ title: (wc.getTitle && wc.getTitle()) || '', artist: '' }));
}
function sendMediaState(playing) {
  if (!mediaWC || mediaWC.isDestroyed()) { try { mainWindow.webContents.send('media-update', { active: false }); } catch (e) {} return; }
  const wc = mediaWC;
  const fromApp = !!(sidebarView && wc === sidebarView.webContents);
  readMediaMeta(wc).then(meta => {
    if (wc !== mediaWC) return;
    try { mainWindow.webContents.send('media-update', { active: true, title: meta.title || '', artist: meta.artist || '', playing: playing, fromApp: fromApp }); } catch (e) {}
  });
}
function clearMedia(wc) {
  if (wc && wc !== mediaWC) return;            // only the active media source can clear the bar
  mediaWC = null;
  try { mainWindow.webContents.send('media-update', { active: false }); } catch (e) {}
}
function wireMedia(wc) {
  // The most recently *playing* source wins, so a paused tab never hides an actively playing one
  wc.on('media-started-playing', () => { mediaWC = wc; sendMediaState(true); });
  wc.on('media-paused', () => { if (wc === mediaWC) sendMediaState(false); });   // keep controls, just flip to play icon
  // Leaving the page (full navigation) tears down the controls; in-page nav (e.g. next YouTube video) does not
  wc.on('did-navigate', () => clearMedia(wc));
  wc.on('destroyed', () => clearMedia(wc));
}

function makeTabView() {
  return new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/pagePreload.js'),
      sandbox: true,
      backgroundThrottling: false,
    },
  });
}

function createTab(tabUrl = 'pace://newtab', background = false) {
  const tabId = ++tabCounter;
  const view = makeTabView();
  tabs[tabId] = view; tabMeta[tabId] = { detached: false };
  attachTabListeners(view, tabId);

  if (!background) {
    if (activeTabId && tabs[activeTabId]) mainWindow.removeBrowserView(tabs[activeTabId]);
    activeTabId = tabId;
    mainWindow.addBrowserView(view);
    view.setBounds({ x: 0, y: CHROME_H, width: 1200, height: 600 });
  }
  navigateView(view, tabUrl);
  mainWindow.webContents.send('tab-created', { tabId, url: formatUrl(tabUrl), active: !background });
  try { if (chromeExtensions) chromeExtensions.addTab(view.webContents, mainWindow); } catch (e) {}
  return tabId;
}

function navigateView(view, tabUrl) {
  const map = { 'pace://newtab': 'newtab.html', 'pace://settings': 'settings.html', 'pace://downloads': 'downloads.html', 'pace://extensions': 'extensions.html', 'pace://history': 'history.html', 'pace://tos': 'tos.html', 'pace://privacy': 'privacy.html', 'pace://passwords': 'passwords.html' };
  const base = (tabUrl || '').split('?')[0];
  // If an extension overrides the new-tab page and the user enabled that, load the extension's page.
  if (base === 'pace://newtab' && newtabOverrideUrl) {
    try { view.webContents.loadURL(newtabOverrideUrl); return; } catch (e) {}
  }
  if (map[base]) view.webContents.loadFile(RENDERER(map[base]));
  else view.webContents.loadURL(tabUrl);
}

// Track an extension that overrides the new-tab page (chrome_url_overrides.newtab).
let newtabOverrideUrl = null;
function refreshNewtabOverride() {
  newtabOverrideUrl = null;
  try {
    const s = loadSettings();
    if (s.useExtensionNewtab === false) return;        // user can turn this off
    const exts = session.defaultSession.getAllExtensions ? session.defaultSession.getAllExtensions() : [];
    for (const ext of exts) {
      const ov = ext && ext.manifest && ext.manifest.chrome_url_overrides && ext.manifest.chrome_url_overrides.newtab;
      if (ov) { newtabOverrideUrl = (ext.url || ('chrome-extension://' + ext.id + '/')) + ov.replace(/^\//, ''); break; }
    }
  } catch (e) { newtabOverrideUrl = null; }
}

function formatUrl(u) {
  if (!u) return '';
  if (u.startsWith('file://')) {
    const m = ['newtab', 'settings', 'downloads', 'extensions', 'history', 'tos', 'privacy', 'passwords'];
    for (const p of m) if (u.includes(p + '.html')) return 'pace://' + p;
    return u;
  }
  return u;
}

function switchTab(tabId) {
  if (!tabs[tabId]) return;
  if (activeTabId && tabs[activeTabId] && !tabMeta[activeTabId].detached) mainWindow.removeBrowserView(tabs[activeTabId]);
  activeTabId = tabId;
  tabMeta[tabId].detached = false;
  mainWindow.addBrowserView(tabs[tabId]);
  const wc = tabs[tabId].webContents;
  mainWindow.webContents.send('tab-switched', { tabId, url: formatUrl(wc.getURL()), title: wc.getTitle(), canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() });
}

function closeTab(tabId) {
  if (!tabs[tabId]) return;
  const wasActive = activeTabId === tabId;
  // Remember the closed tab's URL so it can be reopened (skip blank/new tabs)
  try {
    const u = formatUrl(tabs[tabId].webContents.getURL());
    if (u && u !== 'pace://newtab') { closedTabs.push(u); if (closedTabs.length > 25) closedTabs.shift(); }
  } catch (e) {}
  if (wasActive && tabMeta[tabId] && !tabMeta[tabId].detached) mainWindow.removeBrowserView(tabs[tabId]);
  try { tabs[tabId].webContents.destroy(); } catch (e) {}
  delete tabs[tabId]; delete tabMeta[tabId];
  mainWindow.webContents.send('tab-closed', { tabId });
  if (wasActive) {
    const ids = Object.keys(tabs).map(Number);
    if (ids.length) switchTab(ids[ids.length - 1]);
    else { activeTabId = null; createTab('pace://newtab'); }
  }
  ensureTab();
}

function ensureTab() {
  if (Object.keys(tabs).length === 0) { activeTabId = null; createTab('pace://newtab'); }
}

function reopenClosedTab() {
  const url = closedTabs.pop();
  createTab(url || 'pace://newtab');
}

function duplicateTab(tabId) {
  if (!tabs[tabId]) return;
  createTab(formatUrl(tabs[tabId].webContents.getURL()) || 'pace://newtab', true);
}

// ─── Layout (renderer-driven) ───────────────────────────────────────────────────
function setPageBounds(bounds) {
  if (!activeTabId || !tabs[activeTabId]) return;
  const view = tabs[activeTabId];
  const meta = tabMeta[activeTabId];
  if (bounds === null) {
    if (!meta.detached) { mainWindow.removeBrowserView(view); meta.detached = true; }
    return;
  }
  if (meta.detached) { mainWindow.addBrowserView(view); meta.detached = false; }
  view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(120, Math.round(bounds.width)), height: Math.max(120, Math.round(bounds.height)) });
}

function setSidebarView(payload) {
  if (!payload || !payload.url) {
    // Hide the panel but DON'T destroy the app — keep its webContents alive so audio keeps playing
    if (sidebarView && sidebarView._attached) { try { mainWindow.removeBrowserView(sidebarView); } catch (e) {} sidebarView._attached = false; }
    return;
  }
  const { url, bounds } = payload;
  if (!sidebarView) {
    sidebarView = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    wireMedia(sidebarView.webContents);
    sidebarView._url = ''; sidebarView._attached = false;
  }
  if (!sidebarView._attached) { mainWindow.addBrowserView(sidebarView); sidebarView._attached = true; }
  // keep sidebar above the active page view
  mainWindow.setTopBrowserView(sidebarView);
  sidebarView.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(80, Math.round(bounds.width)), height: Math.max(80, Math.round(bounds.height)) });
  if (sidebarView._url !== url) { sidebarView._url = url; sidebarView.webContents.loadURL(url); }
}

// Settings shown as a centered popup panel (its own BrowserView) instead of a full page
function setSettingsPanel(bounds) {
  if (!bounds) {
    if (settingsView) { try { mainWindow.removeBrowserView(settingsView); settingsView.webContents.destroy(); } catch (e) {} settingsView = null; }
    return;
  }
  if (!settingsView) {
    settingsView = new BrowserView({
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
        preload: path.join(__dirname, '../preload/pagePreload.js') },
    });
    mainWindow.addBrowserView(settingsView);
    settingsView.webContents.on('dom-ready', () => settingsView.webContents.insertCSS(THIN_SCROLLBAR_CSS).catch(() => {}));
    settingsView.webContents.loadFile(RENDERER('settings.html'));
  }
  mainWindow.setTopBrowserView(settingsView);
  settingsView.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(320, Math.round(bounds.width)), height: Math.max(240, Math.round(bounds.height)) });
}

// ─── Preloading (improved) ───────────────────────────────────────────────────────
function preloadUrl(rawUrl, force) {
  const s = loadSettings();
  if (!s.fastMode) return;
  if (s.lightResources && !force) return;   // hover-preload (force) is allowed even in Low Resources mode
  const normalized = normalizeUrl(rawUrl, s);
  if (!normalized || !/^https?:\/\//.test(normalized) || preloadViews[normalized]) return;
  // Never preload auth/SSO/checkout style pages — many refuse to load in a hidden/background view
  // (X-Frame-Options, backgrounding detection, OAuth state) and would adopt as a blank page.
  if (isNoPreloadUrl(normalized)) return;
  const pv = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: true, preload: path.join(__dirname, '../preload/pagePreload.js') } });
  // keep it off-screen, tiny, never added to window so it can't steal focus/paint
  preloadViews[normalized] = { view: pv, time: Date.now(), ok: false, failed: false };
  const wc = pv.webContents;
  wc.once('did-finish-load', () => { if (preloadViews[normalized]) preloadViews[normalized].ok = true; });
  wc.on('did-fail-load', (e, code) => { if (code !== -3 && preloadViews[normalized]) preloadViews[normalized].failed = true; });
  // Give the preloaded page a realistic viewport so layout/paint matches a normal tab.
  try { pv.setBounds({ x: 0, y: CHROME_H, width: 1280, height: 800 }); } catch (e) {}
  try { wc.loadURL(normalized); } catch (e) {}
  // In Low Resources mode keep the warm-cache smaller to stay gentle on RAM
  const max = s.lightResources ? 2 : Math.max(2, s.preloadCount || 6);
  const keys = Object.keys(preloadViews).sort((a, b) => preloadViews[a].time - preloadViews[b].time);
  while (keys.length > max) {
    const oldest = keys.shift();
    if (preloadViews[oldest]) { try { preloadViews[oldest].view.webContents.destroy(); } catch (e) {} delete preloadViews[oldest]; }
  }
}
// Domains we should never warm up in the background (auth, SSO, payments).
function isNoPreloadUrl(u) {
  let host = '';
  try { host = new URL(u).hostname.toLowerCase(); } catch (e) { return false; }
  const path2 = (() => { try { return new URL(u).pathname.toLowerCase(); } catch (e) { return ''; } })();
  const blockedHosts = ['appleid.apple.com', 'idmsa.apple.com', 'accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'signin.aws.amazon.com', 'auth0.com', 'okta.com', 'login.yahoo.com', 'id.atlassian.com'];
  if (blockedHosts.some(h => host === h || host.endsWith('.' + h))) return true;
  // generic auth/checkout path heuristics
  if (/(^|\.)(login|signin|auth|account|accounts|sso|id)\./.test(host)) return true;
  if (/\/(login|signin|sign-in|auth|oauth|checkout|payment)(\/|$|\?)/.test(path2)) return true;
  return false;
}

function navigateTab(tabId, rawUrl) {
  const s = loadSettings();
  const tid = tabId || activeTabId;
  if (!tabs[tid]) return;
  const isInternal = (rawUrl || '').startsWith('pace://');
  const normalized = isInternal ? rawUrl : normalizeUrl(rawUrl, s);
  if (!normalized) return;

  if (!isInternal && preloadViews[normalized]) {
    const entry = preloadViews[normalized];
    delete preloadViews[normalized];
    const pv = entry.view;
    let usable = false;
    try {
      const wc0 = pv.webContents;
      // Usable only if it didn't fail to load and actually has a real document loaded.
      usable = !entry.failed && !wc0.isCrashed() && !!(wc0.getURL() && wc0.getURL() !== 'about:blank');
    } catch (e) { usable = false; }
    if (!usable) {
      // Throw away the dead/blank preloaded view and just navigate normally.
      try { pv.webContents.destroy(); } catch (e) {}
      navigateView(tabs[tid], normalized);
      return;
    }
    // Adopt the warmed-up view
    const wasActive = activeTabId === tid;
    const wasDetached = tabMeta[tid].detached;
    if (wasActive && !wasDetached) mainWindow.removeBrowserView(tabs[tid]);
    try { tabs[tid].webContents.destroy(); } catch (e) {}
    tabs[tid] = pv;
    attachTabListeners(pv, tid);
    if (wasActive && !wasDetached) { mainWindow.addBrowserView(pv); }
    const wc = pv.webContents;
    mainWindow.webContents.send('tab-update', { tabId: tid, url: formatUrl(wc.getURL() || normalized), title: wc.getTitle(), loading: wc.isLoading(), canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() });
    // ask renderer to re-apply bounds for the new view
    mainWindow.webContents.send('relayout');
  } else {
    navigateView(tabs[tid], normalized);
  }
}

function normalizeUrl(input, settings) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('pace://') || trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('file://') || trimmed.startsWith('about:')) return trimmed;
  const urlPat = /^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(\/.*)?$/;
  if (urlPat.test(trimmed) && !trimmed.includes(' ')) return 'https://' + trimmed;
  if (/^localhost(:\d+)?(\/.*)?$/.test(trimmed)) return 'http://' + trimmed;
  const s = settings || loadSettings();
  const engines = s.searchEngines || defaultSettings.searchEngines;
  const engine = engines[s.searchEngine] || engines.google;
  return engine + encodeURIComponent(trimmed);
}

// ─── Page context menu (Chrome-like) ─────────────────────────────────────────────
function buildPageContextMenu(view, tabId, params) {
  const wc = view.webContents;
  const url = wc.getURL();
  if (url.startsWith('file://')) return; // internal pages manage their own menus
  const menu = new Menu();
  const add = (opts) => menu.append(new MenuItem(opts));
  const sep = () => menu.append(new MenuItem({ type: 'separator' }));

  if (params.linkURL) {
    add({ label: 'Open Link in New Tab', click: () => createTab(params.linkURL, true) });
    add({ label: 'Open Link in New Foreground Tab', click: () => createTab(params.linkURL, false) });
    add({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) });
    sep();
  }
  if (params.mediaType === 'image') {
    add({ label: 'Open Image in New Tab', click: () => createTab(params.srcURL, true) });
    add({ label: 'Save Image As…', click: () => wc.downloadURL(params.srcURL) });
    add({ label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) });
    add({ label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) });
    sep();
  }
  if (params.isEditable) {
    add({ label: 'Undo', role: 'undo', enabled: params.editFlags.canUndo });
    add({ label: 'Redo', role: 'redo', enabled: params.editFlags.canRedo });
    sep();
    add({ label: 'Cut', role: 'cut', enabled: params.editFlags.canCut });
    add({ label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy });
    add({ label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste });
    add({ label: 'Select All', role: 'selectAll' });
    sep();
  } else if (params.selectionText) {
    add({ label: 'Copy', role: 'copy' });
    const s = loadSettings();
    const eng = (s.searchEngines || {})[s.searchEngine] || 'https://www.google.com/search?q=';
    const q = params.selectionText.slice(0, 80);
    add({ label: `Search for “${q}”`, click: () => createTab(eng + encodeURIComponent(params.selectionText), true) });
    sep();
  }
  add({ label: 'Back', enabled: wc.canGoBack(), click: () => wc.goBack() });
  add({ label: 'Forward', enabled: wc.canGoForward(), click: () => wc.goForward() });
  add({ label: 'Reload', click: () => wc.reload() });
  sep();
  add({ label: 'Copy Page URL', click: () => clipboard.writeText(url) });
  add({ label: 'Save Page As…', click: () => wc.downloadURL(url) });
  add({ label: 'Print…', click: () => wc.print() });
  sep();
  add({ label: 'Inspect Element', click: () => { wc.inspectElement(params.x, params.y); if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' }); } });
  menu.popup({ window: mainWindow });
}

// ─── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window-maximize', () => { if (!mainWindow) return; mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); });
ipcMain.on('window-close', () => mainWindow && mainWindow.close());
ipcMain.handle('window-is-maximized', () => mainWindow ? mainWindow.isMaximized() : false);

ipcMain.on('new-tab', (e, { url } = {}) => createTab(url || 'pace://newtab'));
ipcMain.on('chrome-ready', () => {
  if (pendingOpenUrl) { createTab(pendingOpenUrl); pendingOpenUrl = null; }
  if (Object.keys(tabs).length === 0) createTab(loadSettings().homePage || 'pace://newtab');
});
ipcMain.on('new-tab-bg', (e, { url } = {}) => createTab(url || 'pace://newtab', true));
ipcMain.on('switch-tab', (e, { tabId }) => switchTab(tabId));
ipcMain.on('close-tab', (e, { tabId }) => closeTab(tabId));
ipcMain.on('duplicate-tab', (e, { tabId }) => duplicateTab(tabId));
ipcMain.on('navigate', (e, { tabId, url }) => navigateTab(tabId, url));
ipcMain.on('preload-url', (e, { url, force }) => { if (url) preloadUrl(url, force); });
ipcMain.on('go-back', () => { if (activeTabId && tabs[activeTabId]) tabs[activeTabId].webContents.goBack(); });
ipcMain.on('go-forward', () => { if (activeTabId && tabs[activeTabId]) tabs[activeTabId].webContents.goForward(); });
ipcMain.on('reload', () => { if (activeTabId && tabs[activeTabId]) tabs[activeTabId].webContents.reload(); });
ipcMain.on('stop-loading', () => { if (activeTabId && tabs[activeTabId]) tabs[activeTabId].webContents.stop(); });

ipcMain.on('set-page-bounds', (e, { bounds }) => setPageBounds(bounds));
ipcMain.on('set-sidebar-view', (e, payload) => setSidebarView(payload));
ipcMain.on('open-settings-panel', (e, { bounds }) => setSettingsPanel(bounds));
ipcMain.on('close-settings-panel', () => { setSettingsPanel(null); mainWindow.webContents.send('settings-panel-closed'); });

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.on('save-settings', (e, s) => {
  saveSettings(s); applyNetworkRules();
  const targets = [mainWindow.webContents];
  Object.values(tabs).forEach(v => { try { targets.push(v.webContents); } catch (e) {} });
  if (sidebarView) try { targets.push(sidebarView.webContents); } catch (e) {}
  if (settingsView) try { targets.push(settingsView.webContents); } catch (e) {}
  targets.forEach(wc => { try { wc.send('settings-changed', s); } catch (e) {} });
});

// ── Default browser + app version + auto-update controls ────────────────────────
ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('default-browser-status', () => {
  try { return { isDefault: app.isDefaultProtocolClient('http') }; } catch (e) { return { isDefault: false }; }
});
ipcMain.handle('set-default-browser', () => {
  let isDefault = false;
  try { app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https'); } catch (e) {}
  try { isDefault = app.isDefaultProtocolClient('http'); } catch (e) {}
  // Windows 10/11 require the user to confirm in Settings. Deep-link straight to Pace Browser's
  // own page in Default Apps (registeredAppUser = the StartMenuInternet name the installer sets).
  if (process.platform === 'win32') {
    let opened = false;
    try { shell.openExternal('ms-settings:defaultapps?registeredAppUser=Pace%20Browser'); opened = true; } catch (e) {}
    if (!opened) { try { shell.openExternal('ms-settings:defaultapps'); } catch (e) {} }
  }
  const s = loadSettings(); s.askedDefault = true; saveSettings(s);
  return { isDefault, opened: process.platform === 'win32' };
});
ipcMain.on('dismiss-default-prompt', () => { const s = loadSettings(); s.askedDefault = true; saveSettings(s); });
function sendToAll(channel, payload) {
  const targets = [];
  try { if (mainWindow) targets.push(mainWindow.webContents); } catch (e) {}
  targets.forEach(wc => { try { wc.send(channel, payload); } catch (e) {} });
}
ipcMain.handle('check-for-updates', async () => {
  if (!autoUpdater) return { ok: false, reason: 'Updater unavailable in this build.' };
  if (!app.isPackaged) return { ok: false, reason: 'Updates only work in the installed app.' };
  const current = app.getVersion();
  // If an update already finished downloading this session, just offer the restart.
  if (updateDownloadedVersion) {
    return { ok: true, upToDate: false, downloaded: true, version: updateDownloadedVersion, current };
  }
  try {
    const prevAuto = autoUpdater.autoDownload;
    autoUpdater.autoDownload = false;
    const r = await autoUpdater.checkForUpdates();
    const latest = (r && r.updateInfo && r.updateInfo.version) || '';
    // Decide "is there a newer version" robustly: prefer electron-updater's own flag,
    // otherwise fall back to a real semver comparison (NOT string equality).
    let newer = false;
    if (r && typeof r.isUpdateAvailable === 'boolean') {
      newer = r.isUpdateAvailable;
    } else if (latest) {
      try { const semver = require('semver'); newer = semver.gt(latest, current); }
      catch (e) { newer = latest !== current; }
    }
    if (!newer) {
      autoUpdater.autoDownload = prevAuto;
      return { ok: true, upToDate: true, version: current, latest: latest || current };
    }
    // A genuinely newer version exists → download it now and surface any real error.
    try {
      await autoUpdater.downloadUpdate(r && r.cancellationToken);
    } catch (e) {
      autoUpdater.autoDownload = prevAuto;
      return { ok: false, reason: 'Found v' + latest + ', but the download failed: ' + String(e && e.message || e), latest, current };
    }
    autoUpdater.autoDownload = prevAuto;
    return { ok: true, upToDate: false, version: latest, current };
  }
  catch (err) { return { ok: false, reason: String(err && err.message || err) }; }
});
ipcMain.on('quit-and-install', () => { try { if (autoUpdater) autoUpdater.quitAndInstall(); } catch (e) {} });

ipcMain.handle('get-history', () => readHistory());
ipcMain.on('clear-history', () => { try { fs.writeFileSync(historyPath, '[]'); } catch (e) {} });
ipcMain.on('remove-history-item', (e, { url, time }) => {
  try { let h = readHistory().filter(x => !(x.url === url && x.time === time)); fs.writeFileSync(historyPath, JSON.stringify(h)); } catch (e) {}
});

ipcMain.handle('get-bookmarks', () => { try { if (fs.existsSync(bookmarksPath)) return JSON.parse(fs.readFileSync(bookmarksPath, 'utf8')); } catch (e) {} return []; });
ipcMain.on('save-bookmarks', (e, b) => { writeBookmarks(b); });
ipcMain.handle('clear-bookmarks', (e, { scope }) => { return clearBookmarks(scope || 'all'); });

// ── Import bookmarks from other browsers / HTML export ──────────────────────────
function otherBrowserBookmarksPath(which) {
  const local = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(app.getPath('home'), 'AppData', 'Roaming');
  const map = {
    chrome: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks'),
    edge:   path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks'),
    brave:  path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Bookmarks'),
    opera:  path.join(appData, 'Opera Software', 'Opera Stable', 'Bookmarks'),
  };
  return map[which];
}
function collectChromeNodes(node, folder, out) {
  if (!node) return;
  if (node.type === 'url' && node.url && /^https?:/i.test(node.url)) out.push({ title: node.name || node.url, url: node.url, folder });
  if (Array.isArray(node.children)) node.children.forEach(c => collectChromeNodes(c, folder, out));
}
function parseHtmlBookmarks(html) {
  const out = []; const re = /<A\s+[^>]*HREF="([^"]+)"[^>]*>([\s\S]*?)<\/A>/gi; let m;
  while ((m = re.exec(html))) { const url = m[1]; if (/^https?:/i.test(url)) out.push({ title: (m[2] || url).replace(/<[^>]+>/g, '').trim() || url, url, folder: 'other' }); }
  return out;
}
ipcMain.handle('import-bookmarks', async (e, { source }) => {
  try {
    let imported = [];
    if (source === 'html') {
      const r = await dialog.showOpenDialog(mainWindow, { title: 'Select a bookmarks HTML file', filters: [{ name: 'Bookmarks', extensions: ['html', 'htm'] }], properties: ['openFile'] });
      if (r.canceled || !r.filePaths[0]) return { ok: false, reason: 'cancelled' };
      imported = parseHtmlBookmarks(fs.readFileSync(r.filePaths[0], 'utf8'));
    } else {
      const p = otherBrowserBookmarksPath(source);
      if (!p || !fs.existsSync(p)) return { ok: false, reason: 'Couldn\u2019t find ' + source + ' bookmarks on this PC. Try “From HTML file…”.' };
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const roots = data.roots || {};
      collectChromeNodes(roots.bookmark_bar, 'bar', imported);
      collectChromeNodes(roots.other, 'other', imported);
      collectChromeNodes(roots.synced, 'other', imported);
    }
    if (!imported.length) return { ok: false, reason: 'No bookmarks found to import.' };
    const existing = readBookmarks();
    const seen = new Set(existing.map(b => b.url));
    let added = 0;
    for (const b of imported) { if (!seen.has(b.url)) { existing.push(b); seen.add(b.url); added++; } }
    try { const tmp = bookmarksPath + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(existing, null, 2)); if (fs.existsSync(bookmarksPath)) { try { fs.copyFileSync(bookmarksPath, bookmarksPath + '.bak'); } catch (e) {} } fs.renameSync(tmp, bookmarksPath); } catch (e) {}
    return { ok: true, count: added, total: imported.length };
  } catch (err) { return { ok: false, reason: String(err.message || err) }; }
});
ipcMain.on('show-bookmarks-bar-menu', (e) => {
  const act = (payload) => mainWindow.webContents.send('bm-bar-action', payload);
  const menu = Menu.buildFromTemplate([
    { label: 'Import bookmarks', submenu: [
      { label: 'From Google Chrome', click: () => act({ action: 'import', source: 'chrome' }) },
      { label: 'From Microsoft Edge', click: () => act({ action: 'import', source: 'edge' }) },
      { label: 'From Brave', click: () => act({ action: 'import', source: 'brave' }) },
      { label: 'From Opera', click: () => act({ action: 'import', source: 'opera' }) },
      { type: 'separator' },
      { label: 'From HTML file\u2026', click: () => act({ action: 'import', source: 'html' }) },
    ]},
    { type: 'separator' },
    { label: 'Clear bookmarks', submenu: [
      { label: 'Clear bookmarks bar', click: () => act({ action: 'clear', scope: 'bar' }) },
      { label: 'Clear other bookmarks', click: () => act({ action: 'clear', scope: 'other' }) },
      { type: 'separator' },
      { label: 'Clear all bookmarks', click: () => act({ action: 'clear', scope: 'all' }) },
    ]},
    { type: 'separator' },
    { label: 'Hide bookmarks bar', click: () => act({ action: 'hide' }) },
  ]);
  menu.popup({ window: mainWindow });
});

ipcMain.handle('get-downloads', () => downloads);
ipcMain.on('clear-downloads', () => { downloads = []; saveDownloads(); });
ipcMain.on('open-file', (e, { filePath }) => shell.openPath(filePath));
ipcMain.on('show-in-folder', (e, { filePath }) => shell.showItemInFolder(filePath));
ipcMain.handle('choose-download-path', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.on('open-external', (e, { url }) => { if (url) shell.openExternal(url); });

ipcMain.handle('get-favicon', async (e, { domain }) => {
  if (!domain) return '';
  if (faviconCache[domain]) return faviconCache[domain];
  const data = await fetchFaviconData(domain);
  if (data) { faviconCache[domain] = data; persistFavicons(); }
  return data;
});

ipcMain.on('show-bookmark-menu', (e, { index }) => {
  const bms = readBookmarks();
  const bm = bms[index];
  if (!bm) return;
  const send = (action) => mainWindow.webContents.send('bookmark-action', { action, index });
  const menu = Menu.buildFromTemplate([
    { label: 'Open', click: () => send('open') },
    { label: 'Open in new tab', click: () => send('open-new') },
    { type: 'separator' },
    { label: 'Edit…', click: () => send('edit') },
    { label: bm.folder === 'other' ? 'Move to Bookmarks bar' : 'Move to Other bookmarks', click: () => send('move') },
    { type: 'separator' },
    { label: 'Delete', click: () => send('delete') },
  ]);
  menu.popup({ window: mainWindow });
});

ipcMain.on('show-other-bookmarks', (e) => {
  const bms = readBookmarks();
  const items = bms.map((b, i) => ({ b, i })).filter(x => x.b.folder === 'other');
  const send = (action, index) => mainWindow.webContents.send('bookmark-action', { action, index });
  const template = items.length ? items.map(({ b, i }) => ({
    label: (b.title || b.url).slice(0, 60),
    submenu: [
      { label: 'Open', click: () => send('open', i) },
      { label: 'Open in new tab', click: () => send('open-new', i) },
      { label: 'Edit…', click: () => send('edit', i) },
      { label: 'Move to Bookmarks bar', click: () => send('move', i) },
      { type: 'separator' },
      { label: 'Delete', click: () => send('delete', i) },
    ],
  })) : [{ label: '(No other bookmarks)', enabled: false }];
  Menu.buildFromTemplate(template).popup({ window: mainWindow });
});
ipcMain.handle('normalize-url', (e, { url }) => normalizeUrl(url, loadSettings()));
ipcMain.on('reopen-closed-tab', () => reopenClosedTab());

ipcMain.on('media-close', () => {
  if (sidebarView && mediaWC === sidebarView.webContents) {
    try { if (sidebarView._attached) mainWindow.removeBrowserView(sidebarView); sidebarView.webContents.destroy(); } catch (e) {}
    sidebarView = null;
    try { mainWindow.webContents.send('sidebar-app-closed'); } catch (e) {}   // so the renderer stops respawning it
  } else if (mediaWC && !mediaWC.isDestroyed()) {
    mediaWC.executeJavaScript("(function(){Array.prototype.slice.call(document.querySelectorAll('video,audio')).forEach(function(e){e.pause();});})()", true).catch(() => {});
  }
  clearMedia();
});

ipcMain.on('media-control', (e, { action }) => {
  if (!mediaWC || mediaWC.isDestroyed()) { clearMedia(); return; }
  if (action === 'playpause') {
    const js = "(function(){var els=Array.prototype.slice.call(document.querySelectorAll('video,audio'));var playing=els.filter(function(e){return !e.paused;});if(playing.length){playing.forEach(function(e){e.pause();});return false;}else{var c=null;for(var i=0;i<els.length;i++){if(els[i].readyState>0){c=els[i];break;}}c=c||els[0];if(c)c.play();return true;}})()";
    mediaWC.executeJavaScript(js, true).then(playing => sendMediaState(playing !== false)).catch(() => {});
  } else {
    const key = action === 'next' ? 'MediaNextTrack' : 'MediaPreviousTrack';
    try { mediaWC.sendInputEvent({ type: 'keyDown', keyCode: key }); mediaWC.sendInputEvent({ type: 'keyUp', keyCode: key }); } catch (e) {}
    setTimeout(() => sendMediaState(true), 500);
  }
});

ipcMain.handle('search-suggestions', async (e, { query }) => {
  const q = (query || '').trim();
  if (!q) return [];
  const engine = loadSettings().searchEngine || 'google';
  let url;
  if (engine === 'duckduckgo') url = 'https://duckduckgo.com/ac/?type=list&q=' + encodeURIComponent(q);
  else if (engine === 'bing') url = 'https://api.bing.com/osjson.aspx?query=' + encodeURIComponent(q);
  else if (engine === 'ecosia') url = 'https://ac.ecosia.org/autocomplete?type=list&q=' + encodeURIComponent(q);
  else url = 'https://suggestqueries.google.com/complete/search?client=firefox&q=' + encodeURIComponent(q); // google/brave/startpage
  return new Promise((resolve) => {
    try {
      const req = net.request(url);
      req.setHeader('User-Agent', CHROME_UA);
      const chunks = [];
      req.on('response', (res) => {
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            const data = JSON.parse(text);
            let list = [];
            if (Array.isArray(data) && Array.isArray(data[1])) list = data[1];          // google/bing/ddg-list
            else if (data && Array.isArray(data.suggestions)) list = data.suggestions.map(s => s.title || s); // ecosia
            resolve(list.filter(x => typeof x === 'string').slice(0, 6));
          } catch (e) { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.end();
    } catch (e) { resolve([]); }
  });
});

ipcMain.handle('clear-browsing-data', async () => {
  try {
    await session.defaultSession.clearStorageData();
    await session.defaultSession.clearCache();
    fs.writeFileSync(historyPath, '[]');
    return true;
  } catch (e) { return false; }
});

// Extensions
ipcMain.handle('get-extensions', () => {
  syncExtMeta();                                  // capture currently-loaded paths/metadata
  const out = [];
  for (const id of Object.keys(extState.meta)) {
    const m = extState.meta[id];
    out.push({ id, name: m.name || id, version: m.version, path: m.path, enabled: !extState.disabled.includes(id), hasPopup: !!m.popup, hasOptions: !!m.options, icon: m.icon || '' });
  }
  return out;
});
ipcMain.handle('install-from-store', async (e, { input }) => {
  const id = (String(input || '').match(/[a-p]{32}/i) || [])[0];
  if (!id) return { ok: false, reason: 'Could not find a 32-character extension ID in that link.' };
  if (!webStore || !webStore.installExtension) return { ok: false, reason: 'Extension installer unavailable — run "npm install" and rebuild.' };
  try {
    let res;
    try { res = await webStore.installExtension(id, { session: session.defaultSession }); }
    catch (e1) { res = await webStore.installExtension(id); }   // tolerate either call signature
    refreshNewtabOverride();
    return { ok: true, ext: { id: (res && res.id) || id, name: (res && res.name) || id } };
  } catch (err) { return { ok: false, reason: 'Install failed: ' + (err && err.message || err) }; }
});
ipcMain.handle('install-extension-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select unpacked extension folder (contains manifest.json)' });
  if (r.canceled || !r.filePaths[0]) return { ok: false, reason: 'cancelled' };
  const dir = r.filePaths[0];
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) return { ok: false, reason: 'No manifest.json found in that folder.' };
  try {
    const loaded = await session.defaultSession.loadExtension(dir, { allowFileAccess: true });
    const list = readExtStore();
    const entry = { id: loaded.id, name: loaded.name || path.basename(dir), version: loaded.manifest && loaded.manifest.version, path: dir, enabled: true, icon: '🧩', source: 'Unpacked' };
    const idx = list.findIndex(x => x.path === dir);
    if (idx >= 0) list[idx] = entry; else list.push(entry);
    writeExtStore(list);
    refreshNewtabOverride();
    return { ok: true, ext: entry };
  } catch (e) { return { ok: false, reason: String(e.message || e) }; }
});
ipcMain.handle('set-extension-enabled', async (e, { id, enabled }) => {
  try {
    if (enabled) {
      const m = extState.meta[id];
      if (m && m.path && fs.existsSync(m.path)) { try { await session.defaultSession.loadExtension(m.path, { allowFileAccess: true }); } catch (_) {} }
      extState.disabled = extState.disabled.filter(x => x !== id);
    } else {
      try { session.defaultSession.removeExtension(id); } catch (_) {}
      if (!extState.disabled.includes(id)) extState.disabled.push(id);
    }
    saveExtState();
    refreshNewtabOverride();
    return { ok: true };
  } catch (err) { return { ok: false, reason: String(err.message || err) }; }
});
ipcMain.handle('open-extension-popup', async (e, { id }) => {
  try {
    const ext = session.defaultSession.getAllExtensions().find(x => x.id === id);
    const m = extState.meta[id] || {};
    if (extState.disabled.includes(id)) return { ok: false, reason: 'This extension is disabled. Enable it first.' };
    if (!ext) return { ok: false, reason: 'Extension is not loaded.' };
    const rel = extPopupPath(ext.manifest) || extOptionsPath(ext.manifest);
    if (!rel) return { ok: false, reason: 'This extension has no popup or options page.' };
    const target = new URL(rel, ext.url).href;     // ext.url is chrome-extension://<id>/
    const isPopup = !!extPopupPath(ext.manifest);
    // Position near the top-right (under the toolbar), like a real browser action popup
    let x, y;
    try { const b = mainWindow.getBounds(); x = b.x + b.width - (isPopup ? 420 : 820) - 16; y = b.y + 84; } catch (_) {}
    const win = new BrowserWindow({
      width: isPopup ? 400 : 800, height: isPopup ? 600 : 640, x, y,
      frame: false, resizable: true, minimizable: false, maximizable: false,
      alwaysOnTop: isPopup, skipTaskbar: isPopup, parent: mainWindow,
      backgroundColor: '#ffffff', show: false,
      webPreferences: { session: session.defaultSession, contextIsolation: true, nodeIntegration: false }
    });
    win.once('ready-to-show', () => win.show());
    if (isPopup) win.on('blur', () => { try { win.close(); } catch (_) {} });  // dismiss popup on click-away
    await win.loadURL(target);
    return { ok: true };
  } catch (err) { return { ok: false, reason: String(err.message || err) }; }
});
ipcMain.handle('remove-extension', async (e, { id }) => {
  try { session.defaultSession.removeExtension(id); } catch (_) {}
  if (webStore && webStore.uninstallExtension) { try { await webStore.uninstallExtension(id, { session: session.defaultSession }); } catch (_) { try { await webStore.uninstallExtension(id); } catch (_2) {} } }
  // Remember where it was installed so we can delete the files, then forget it.
  const meta = extState.meta[id] || {};
  const extDir = meta.path || '';
  delete extState.meta[id];
  extState.disabled = extState.disabled.filter(x => x !== id);
  saveExtState();
  // Drop from the unpacked store if present
  try { writeExtStore(readExtStore().filter(x => x.id !== id && x.path !== id)); } catch (_) {}
  // Delete the on-disk extension folder so it can't reload on next launch (only inside our managed ext dirs).
  try {
    if (extDir && fs.existsSync(extDir)) {
      const managedRoots = [path.join(userDataPath, 'WebStoreExtensions'), path.join(userDataPath, 'Extensions'), path.join(userDataPath, 'extensions')].filter(Boolean);
      if (managedRoots.some(root => extDir.startsWith(root))) {
        fs.rmSync(extDir, { recursive: true, force: true });
      }
    }
  } catch (_) {}
  // Remove it from the pinned/favorites slots and tell the chrome to re-render.
  try {
    const s = loadSettings();
    if (Array.isArray(s.pinnedExtensions) && s.pinnedExtensions.includes(id)) {
      s.pinnedExtensions = s.pinnedExtensions.filter(x => x !== id);
      saveSettings(s);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings-changed', { pinnedExtensions: s.pinnedExtensions });
    }
  } catch (_) {}
  refreshNewtabOverride();
  return { ok: true };
});

// Tab context menu (built natively but triggered from renderer chrome)
ipcMain.on('show-tab-menu', (e, { tabId }) => {
  const ids = Object.keys(tabs).map(Number);
  const menu = new Menu();
  menu.append(new MenuItem({ label: 'New tab', click: () => createTab('pace://newtab') }));
  menu.append(new MenuItem({ label: 'New tab to the right', click: () => createTab('pace://newtab') }));
  menu.append(new MenuItem({ type: 'separator' }));
  menu.append(new MenuItem({ label: 'Reload', click: () => { if (tabs[tabId]) tabs[tabId].webContents.reload(); } }));
  menu.append(new MenuItem({ label: 'Duplicate', click: () => duplicateTab(tabId) }));
  menu.append(new MenuItem({ type: 'separator' }));
  menu.append(new MenuItem({ label: 'Close tab', click: () => closeTab(tabId) }));
  menu.append(new MenuItem({ label: 'Close other tabs', enabled: ids.length > 1, click: () => { Object.keys(tabs).map(Number).filter(id => id !== tabId).forEach(closeTab); } }));
  menu.append(new MenuItem({ label: 'Close tabs to the right', enabled: ids.indexOf(tabId) < ids.length - 1, click: () => { ids.filter(id => id > tabId).forEach(closeTab); } }));
  menu.append(new MenuItem({ type: 'separator' }));
  menu.append(new MenuItem({ label: 'Reopen closed tab', accelerator: 'CmdOrCtrl+Shift+T', enabled: closedTabs.length > 0, click: () => reopenClosedTab() }));
  menu.popup({ window: mainWindow });
});

// ─── pace:// protocol + boot ─────────────────────────────────────────────────────
// ─── Password manager (AES-256-GCM, scrypt KDF, zero-knowledge) ──────────────────
// Security model:
//  • Master password is NEVER stored. We derive a 32-byte key with scrypt (memory-hard).
//  • A random 16-byte salt is generated per vault and stored in cleartext (salts aren't secret).
//  • Each entry's secret fields are encrypted with AES-256-GCM using a fresh random 12-byte IV.
//  • A "verifier" blob (encrypted known token) lets us check the master password without
//    storing it: if it decrypts and the auth tag verifies, the password is correct.
//  • The derived key lives in memory only while the vault is unlocked, and is wiped on lock.
//  • All crypto happens here in the main process — the renderer never sees the key or plaintext
//    at rest, only the decrypted entries it explicitly requests while unlocked.
const crypto = require('crypto');
const VAULT_VERIFIER_TOKEN = 'pace-vault-ok-v1';
let vaultKey = null;          // Buffer(32) when unlocked, else null
let vaultUnlocked = false;

function readVault() {
  try { if (fs.existsSync(vaultPath)) return JSON.parse(fs.readFileSync(vaultPath, 'utf8')); } catch (e) {}
  return null;
}
function writeVaultFile(obj) {
  try {
    const tmp = vaultPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    if (fs.existsSync(vaultPath)) { try { fs.copyFileSync(vaultPath, vaultPath + '.bak'); } catch (e) {} }
    fs.renameSync(tmp, vaultPath);
    return true;
  } catch (e) { return false; }
}
function deriveKey(masterPassword, saltB64) {
  const salt = Buffer.from(saltB64, 'base64');
  // scrypt with strong cost params; N=2^15 balances security and unlock latency on desktop.
  return crypto.scryptSync(String(masterPassword), salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
function encryptField(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), ct: enc.toString('base64'), tag: tag.toString('base64') };
}
function decryptField(blob, key) {
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
function vaultExists() { const v = readVault(); return !!(v && v.salt && v.verifier); }

// ── Windows Hello (real, via PowerShell + Windows Runtime UserConsentVerifier) ────
// This triggers the actual Windows Hello dialog with NO native module and NO compiling —
// it runs a short PowerShell script that calls the WinRT UserConsentVerifier API. If you
// later install a native module exposing isAvailable()/requestVerification(), that's used first.
//
// Key protection: enabling Hello generates a random 32-byte "hello key", AES-encrypts the
// master-derived vault key with it, and stores that wrapped blob in the vault. The hello key is
// itself wrapped with a machine-bound value so it isn't stored in plaintext. Unlock requires a
// successful Hello verification, then unwraps the vault key. The master password always works too.
let helloModule = null;
try { helloModule = require('pace-windows-hello'); } catch (e) { helloModule = null; } // optional native addon

// Shared PowerShell preamble that loads the WinRT type and provides an Await helper for async ops.
const PS_HELLO_PREAMBLE = [
  "$ErrorActionPreference='Stop'",
  "try {",
  "  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null",
  "  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  "  function Await($op,$t){ $g=$asTask.MakeGenericMethod($t); $k=$g.Invoke($null,@($op)); $k.Wait(-1) | Out-Null; $k.Result }",
  "  [void][Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]"
].join("\n");

function runHelloScript(scriptBody) {
  return new Promise((resolve) => {
    try {
      const { spawn } = require('child_process');
      const tmp = path.join(os.tmpdir(), 'pace-hello-' + crypto.randomBytes(5).toString('hex') + '.ps1');
      fs.writeFileSync(tmp, scriptBody, 'utf8');
      const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', tmp], { windowsHide: true });
      let out = '';
      ps.stdout.on('data', d => { out += d.toString(); });
      ps.on('close', () => { try { fs.unlinkSync(tmp); } catch (e) {} resolve(out); });
      ps.on('error', () => { try { fs.unlinkSync(tmp); } catch (e) {} resolve(''); });
    } catch (e) { resolve(''); }
  });
}
function lastToken(out) { return String(out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() || ''; }

async function helloAvailable() {
  if (process.platform !== 'win32') return false;
  if (helloModule && typeof helloModule.isAvailable === 'function') {
    try { return await helloModule.isAvailable(); } catch (e) {}
  }
  const script = PS_HELLO_PREAMBLE + "\n"
    + "  $a = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])\n"
    + "  if (\"$a\" -eq 'Available'){ Write-Output 'AVAILABLE' } else { Write-Output 'UNAVAILABLE' }\n"
    + "} catch { Write-Output 'ERROR' }";
  return lastToken(await runHelloScript(script)) === 'AVAILABLE';
}
async function helloAuthenticate(reason) {
  if (helloModule && typeof helloModule.requestVerification === 'function') {
    try { return await helloModule.requestVerification(reason || 'Verify to unlock Pace passwords'); } catch (e) {}
  }
  if (process.platform !== 'win32') return false;
  const msg = String(reason || 'Unlock Pace passwords').replace(/[`'"$\r\n]/g, ' ');
  const script = PS_HELLO_PREAMBLE + "\n"
    + "  $r = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('" + msg + "')) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])\n"
    + "  if (\"$r\" -eq 'Verified'){ Write-Output 'VERIFIED' } else { Write-Output 'FAILED' }\n"
    + "} catch { Write-Output 'ERROR' }";
  return lastToken(await runHelloScript(script)) === 'VERIFIED';
}
// Machine-bound wrap so the stored hello key isn't plaintext.
function machineKey() {
  const seed = [os.hostname(), os.platform(), os.arch(), (os.userInfo().username || ''), app.getPath('userData')].join('|');
  return crypto.createHash('sha256').update('pace-hello-v1|' + seed).digest();
}

// Create the vault for the first time with a chosen master password.
ipcMain.handle('vault-create', (e, { masterPassword }) => {
  try {
    if (vaultExists()) return { ok: false, reason: 'A vault already exists.' };
    if (!masterPassword || String(masterPassword).length < 8) return { ok: false, reason: 'Master password must be at least 8 characters.' };
    const salt = crypto.randomBytes(16).toString('base64');
    const key = deriveKey(masterPassword, salt);
    const verifier = encryptField(VAULT_VERIFIER_TOKEN, key);
    const obj = { version: 1, kdf: 'scrypt', salt, verifier, entries: [] };
    if (!writeVaultFile(obj)) return { ok: false, reason: 'Could not write vault.' };
    vaultKey = key; vaultUnlocked = true;
    return { ok: true };
  } catch (err) { return { ok: false, reason: String(err && err.message || err) }; }
});

// Unlock an existing vault.
ipcMain.handle('vault-unlock', (e, { masterPassword }) => {
  try {
    const v = readVault();
    if (!v || !v.salt || !v.verifier) return { ok: false, reason: 'No vault yet.' };
    const key = deriveKey(masterPassword, v.salt);
    let token = '';
    try { token = decryptField(v.verifier, key); } catch (_) { token = ''; }
    if (token !== VAULT_VERIFIER_TOKEN) return { ok: false, reason: 'Incorrect master password.' };
    vaultKey = key; vaultUnlocked = true;
    return { ok: true };
  } catch (err) { return { ok: false, reason: 'Incorrect master password.' }; }
});

ipcMain.handle('vault-lock', () => {
  if (vaultKey) { try { vaultKey.fill(0); } catch (_) {} }
  vaultKey = null; vaultUnlocked = false;
  return { ok: true };
});

ipcMain.handle('vault-status', () => ({ exists: vaultExists(), unlocked: vaultUnlocked }));

// List entries. Returns metadata always; passwords are only decrypted when reveal=true.
ipcMain.handle('vault-list', (e, opts) => {
  if (!vaultUnlocked || !vaultKey) return { ok: false, reason: 'Vault is locked.' };
  const reveal = !!(opts && opts.reveal);
  const v = readVault(); if (!v) return { ok: false, reason: 'No vault.' };
  const out = (v.entries || []).map(en => {
    const row = { id: en.id, site: en.site, username: en.username, url: en.url || '', updated: en.updated || 0 };
    if (reveal) { try { row.password = decryptField(en.password, vaultKey); } catch (_) { row.password = ''; } }
    return row;
  });
  return { ok: true, entries: out };
});

// Decrypt a single entry's password (used by the per-row "reveal" / copy button).
ipcMain.handle('vault-get-password', (e, { id }) => {
  if (!vaultUnlocked || !vaultKey) return { ok: false, reason: 'Vault is locked.' };
  const v = readVault(); if (!v) return { ok: false, reason: 'No vault.' };
  const en = (v.entries || []).find(x => x.id === id);
  if (!en) return { ok: false, reason: 'Not found.' };
  try { return { ok: true, password: decryptField(en.password, vaultKey) }; }
  catch (_) { return { ok: false, reason: 'Decrypt failed.' }; }
});

// Add or update an entry.
ipcMain.handle('vault-save-entry', (e, { id, site, username, password, url }) => {
  if (!vaultUnlocked || !vaultKey) return { ok: false, reason: 'Vault is locked.' };
  const v = readVault(); if (!v) return { ok: false, reason: 'No vault.' };
  v.entries = v.entries || [];
  if (id) {
    const en = v.entries.find(x => x.id === id);
    if (!en) return { ok: false, reason: 'Not found.' };
    en.site = site || en.site; en.username = username || ''; en.url = url || '';
    if (typeof password === 'string' && password.length) en.password = encryptField(password, vaultKey);
    en.updated = Date.now();
  } else {
    v.entries.push({
      id: crypto.randomUUID(), site: site || '', username: username || '', url: url || '',
      password: encryptField(password || '', vaultKey), updated: Date.now()
    });
  }
  if (!writeVaultFile(v)) return { ok: false, reason: 'Could not save.' };
  return { ok: true };
});

ipcMain.handle('vault-delete-entry', (e, { id }) => {
  if (!vaultUnlocked || !vaultKey) return { ok: false, reason: 'Vault is locked.' };
  const v = readVault(); if (!v) return { ok: false, reason: 'No vault.' };
  v.entries = (v.entries || []).filter(x => x.id !== id);
  if (!writeVaultFile(v)) return { ok: false, reason: 'Could not save.' };
  return { ok: true };
});

// Change the master password: re-derive a new key and re-encrypt every entry + verifier.
ipcMain.handle('vault-change-master', (e, { currentPassword, newPassword }) => {
  try {
    const v = readVault();
    if (!v) return { ok: false, reason: 'No vault.' };
    const oldKey = deriveKey(currentPassword, v.salt);
    let token = ''; try { token = decryptField(v.verifier, oldKey); } catch (_) {}
    if (token !== VAULT_VERIFIER_TOKEN) return { ok: false, reason: 'Current master password is incorrect.' };
    if (!newPassword || String(newPassword).length < 8) return { ok: false, reason: 'New master password must be at least 8 characters.' };
    const newSalt = crypto.randomBytes(16).toString('base64');
    const newKey = deriveKey(newPassword, newSalt);
    const entries = (v.entries || []).map(en => {
      let plain = ''; try { plain = decryptField(en.password, oldKey); } catch (_) { plain = ''; }
      return { ...en, password: encryptField(plain, newKey) };
    });
    const obj = { version: 1, kdf: 'scrypt', salt: newSalt, verifier: encryptField(VAULT_VERIFIER_TOKEN, newKey), entries };
    if (!writeVaultFile(obj)) return { ok: false, reason: 'Could not write vault.' };
    vaultKey = newKey; vaultUnlocked = true;
    return { ok: true };
  } catch (err) { return { ok: false, reason: String(err && err.message || err) }; }
});

// Generate a strong random password (used by the "generate" button).
ipcMain.handle('vault-generate', (e, opts) => {
  const len = Math.min(64, Math.max(8, (opts && opts.length) || 20));
  const sets = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+[]{}';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += sets[bytes[i] % sets.length];
  return { ok: true, password: out };
});

// ── Windows Hello unlock IPC ──
ipcMain.handle('hello-status', async () => {
  const v = readVault();
  return { available: await helloAvailable(), enabled: !!(v && v.hello) };
});

// Enable Hello: requires the vault to be unlocked (so we have the real key to wrap).
ipcMain.handle('hello-enable', async () => {
  try {
    if (!vaultUnlocked || !vaultKey) return { ok: false, reason: 'Unlock the vault first.' };
    if (!(await helloAvailable())) return { ok: false, reason: 'Windows Hello isn’t available on this device yet.' };
    const ok = await helloAuthenticate('Set up Windows Hello for Pace passwords');
    if (!ok) return { ok: false, reason: 'Windows Hello verification was cancelled.' };
    const v = readVault(); if (!v) return { ok: false, reason: 'No vault.' };
    const helloKey = crypto.randomBytes(32);
    // wrap the vault key with the hello key, and wrap the hello key with the machine key
    const wrappedVaultKey = encryptField(vaultKey.toString('base64'), helloKey);
    const wrappedHelloKey = encryptField(helloKey.toString('base64'), machineKey());
    v.hello = { wrappedVaultKey, wrappedHelloKey };
    if (!writeVaultFile(v)) return { ok: false, reason: 'Could not save.' };
    return { ok: true };
  } catch (err) { return { ok: false, reason: String(err && err.message || err) }; }
});

ipcMain.handle('hello-disable', () => {
  try { const v = readVault(); if (v && v.hello) { delete v.hello; writeVaultFile(v); } return { ok: true }; }
  catch (e) { return { ok: false }; }
});

// Unlock the vault using Windows Hello instead of the master password.
ipcMain.handle('hello-unlock', async () => {
  try {
    const v = readVault();
    if (!v || !v.hello) return { ok: false, reason: 'Hello not set up.' };
    if (!(await helloAvailable())) return { ok: false, reason: 'Windows Hello unavailable.' };
    const ok = await helloAuthenticate('Unlock Pace passwords');
    if (!ok) return { ok: false, reason: 'Verification failed.' };
    const helloKeyB64 = decryptField(v.hello.wrappedHelloKey, machineKey());
    const helloKey = Buffer.from(helloKeyB64, 'base64');
    const vaultKeyB64 = decryptField(v.hello.wrappedVaultKey, helloKey);
    vaultKey = Buffer.from(vaultKeyB64, 'base64');
    vaultUnlocked = true;
    return { ok: true };
  } catch (err) { return { ok: false, reason: 'Could not unlock with Hello.' }; }
});

// ── Import passwords from a Chrome/Edge/Brave CSV export ──
// Chromium browsers export: name,url,username,password (header row present).
ipcMain.handle('vault-import-csv', async () => {
  try {
    if (!vaultUnlocked || !vaultKey) return { ok: false, reason: 'Unlock the vault first.' };
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import passwords from CSV',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, reason: 'cancelled' };
    const text = fs.readFileSync(res.filePaths[0], 'utf8');
    const rows = parseCsv(text);
    if (!rows.length) return { ok: false, reason: 'No rows found in CSV.' };
    // Map header columns (Chrome/Edge/Brave use name,url,username,password; order can vary).
    const header = rows[0].map(h => h.trim().toLowerCase());
    const ci = {
      name: header.indexOf('name'),
      url: header.indexOf('url'),
      username: header.indexOf('username'),
      password: header.indexOf('password'),
    };
    if (ci.password === -1) return { ok: false, reason: 'CSV is missing a "password" column. Use a Chrome/Edge/Brave export.' };
    const v = readVault(); if (!v) return { ok: false, reason: 'No vault.' };
    v.entries = v.entries || [];
    let added = 0, skipped = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; if (!r || !r.length) continue;
      const password = ci.password > -1 ? (r[ci.password] || '') : '';
      if (!password) { skipped++; continue; }
      const url = ci.url > -1 ? (r[ci.url] || '') : '';
      const username = ci.username > -1 ? (r[ci.username] || '') : '';
      let site = ci.name > -1 ? (r[ci.name] || '') : '';
      if (!site && url) { try { site = new URL(url).hostname; } catch (e) { site = url; } }
      // de-dupe on url-domain + username
      const dup = v.entries.find(en => (en.username || '') === username && (en.url || '') === url);
      if (dup) { skipped++; continue; }
      v.entries.push({ id: crypto.randomUUID(), site: site || url || '(imported)', username, url, password: encryptField(password, vaultKey), updated: Date.now() });
      added++;
    }
    if (!writeVaultFile(v)) return { ok: false, reason: 'Could not save imported passwords.' };
    return { ok: true, added, skipped };
  } catch (err) { return { ok: false, reason: String(err && err.message || err) }; }
});

// Minimal RFC-4180-ish CSV parser (handles quoted fields, commas, escaped quotes, CRLF).
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let i = 0; let inQuotes = false;
  text = String(text).replace(/^\uFEFF/, ''); // strip BOM
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length && !(r.length === 1 && r[0] === ''));
}

// ─── Autofill (security-critical) ────────────────────────────────────────────────
// Trust model:
//   • The web page NEVER supplies its own origin — we read it from event.senderFrame,
//     which the page cannot forge. All matching is done against THAT origin.
//   • autofill-query returns usernames only (never passwords), so a page can't scrape
//     secrets just by being open.
//   • autofill-fill returns a password only when (a) the vault is unlocked, (b) the user
//     triggered it (the content script only calls it from a click handler), and (c) the
//     requested entry's saved domain matches the requesting frame's registrable domain.
//   • A cross-origin page can therefore only ever receive credentials that belong to it,
//     which it would obtain anyway when the user logs in — so no cross-site exfiltration.
function registrableDomain(host) {
  host = String(host || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!host || host === 'localhost') return host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host; // IPv4
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  // Common multi-label public suffixes so e.g. example.co.uk -> example.co.uk
  const twoLevelTlds = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'co.kr', 'co.nz', 'co.za', 'com.au', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.sg', 'com.hk']);
  const lastTwo = parts.slice(-2).join('.');
  if (twoLevelTlds.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}
function frameHost(event) {
  try {
    const url = event && event.senderFrame ? event.senderFrame.url : '';
    return new URL(url).hostname;
  } catch (e) { return ''; }
}
function entryHost(en) {
  try { if (en.url) return new URL(/^https?:\/\//.test(en.url) ? en.url : ('https://' + en.url)).hostname; } catch (e) {}
  // fall back to treating the site name as a host if it looks like one
  try { if (en.site && /\./.test(en.site)) return new URL('https://' + en.site).hostname; } catch (e) {}
  return '';
}
function entriesForHost(host) {
  const v = readVault(); if (!v) return [];
  const rd = registrableDomain(host);
  if (!rd) return [];
  return (v.entries || []).filter(en => {
    const eh = entryHost(en);
    return eh && registrableDomain(eh) === rd;
  });
}

// Page asks: do we have logins for this frame's site? (usernames only)
ipcMain.handle('autofill-query', (event) => {
  try {
    const s = loadSettings();
    if (s.autofill === false) return { ok: true, unlocked: vaultUnlocked, matches: [], disabled: true };
    const host = frameHost(event);
    if (!host) return { ok: true, unlocked: vaultUnlocked, matches: [] };
    if (!vaultUnlocked || !vaultKey) {
      // Tell the page whether there *would* be matches, so it can show an "unlock" hint,
      // without revealing anything (no usernames while locked). Also whether Hello is set up.
      const v = readVault();
      return { ok: true, unlocked: false, hasMatches: entriesForHost(host).length > 0, helloEnabled: !!(v && v.hello), matches: [] };
    }
    const matches = entriesForHost(host).map(en => ({ id: en.id, username: en.username || '', site: en.site || '' }));
    return { ok: true, unlocked: true, matches };
  } catch (e) { return { ok: false, matches: [] }; }
});

// Page asks to fill a specific entry — returns the password ONLY if origin matches.
ipcMain.handle('autofill-fill', (event, { id }) => {
  try {
    if (!vaultUnlocked || !vaultKey) return { ok: false, reason: 'locked' };
    const host = frameHost(event);
    const rd = registrableDomain(host);
    const v = readVault(); if (!v) return { ok: false };
    const en = (v.entries || []).find(x => x.id === id);
    if (!en) return { ok: false };
    // Critical: the entry's domain must match the requesting frame's domain.
    if (!rd || registrableDomain(entryHost(en)) !== rd) return { ok: false, reason: 'origin-mismatch' };
    let password = '';
    try { password = decryptField(en.password, vaultKey); } catch (_) { return { ok: false }; }
    return { ok: true, username: en.username || '', password };
  } catch (e) { return { ok: false }; }
});

// Page offers to save a newly-entered login. Scoped to the frame's own origin.
ipcMain.handle('autofill-save', (event, { username, password }) => {
  try {
    const s = loadSettings();
    if (s.autofill === false) return { ok: false, reason: 'disabled' };
    if (!vaultUnlocked || !vaultKey) return { ok: false, reason: 'locked' };
    const host = frameHost(event);
    if (!host || !password) return { ok: false };
    const v = readVault(); if (!v) return { ok: false };
    v.entries = v.entries || [];
    const rd = registrableDomain(host);
    // De-dupe: if an entry for this domain + username already exists, update its password.
    const existing = v.entries.find(en => registrableDomain(entryHost(en)) === rd && (en.username || '') === (username || ''));
    if (existing) {
      existing.password = encryptField(password, vaultKey);
      existing.updated = Date.now();
    } else {
      v.entries.push({
        id: crypto.randomUUID(), site: host, username: username || '', url: 'https://' + host,
        password: encryptField(password, vaultKey), updated: Date.now()
      });
    }
    if (!writeVaultFile(v)) return { ok: false };
    return { ok: true };
  } catch (e) { return { ok: false }; }
});

// Lets the content script know whether autofill is enabled (it reads this on load).
ipcMain.handle('autofill-enabled', () => {
  try { return { enabled: loadSettings().autofill !== false }; } catch (e) { return { enabled: true }; }
});

// Unlock the vault from the in-page autofill prompt (no redirect to pace://passwords).
ipcMain.handle('autofill-unlock', (e, { masterPassword }) => {
  try {
    const v = readVault();
    if (!v || !v.salt || !v.verifier) return { ok: false, reason: 'No vault yet.' };
    const key = deriveKey(masterPassword, v.salt);
    let token = ''; try { token = decryptField(v.verifier, key); } catch (_) {}
    if (token !== VAULT_VERIFIER_TOKEN) return { ok: false, reason: 'Incorrect master password.' };
    vaultKey = key; vaultUnlocked = true;
    return { ok: true };
  } catch (err) { return { ok: false, reason: 'Incorrect master password.' }; }
});
ipcMain.handle('autofill-hello-unlock', async () => {
  try {
    const v = readVault();
    if (!v || !v.hello) return { ok: false, reason: 'Hello not set up.' };
    if (!(await helloAvailable())) return { ok: false, reason: 'Windows Hello unavailable.' };
    const ok = await helloAuthenticate('Unlock Pace passwords');
    if (!ok) return { ok: false, reason: 'Verification failed.' };
    const helloKey = Buffer.from(decryptField(v.hello.wrappedHelloKey, machineKey()), 'base64');
    vaultKey = Buffer.from(decryptField(v.hello.wrappedVaultKey, helloKey), 'base64');
    vaultUnlocked = true;
    return { ok: true };
  } catch (err) { return { ok: false, reason: 'Could not unlock with Hello.' }; }
});

app.whenReady().then(async () => {
  protocol.registerFileProtocol('pace', (request, callback) => {
    const page = request.url.replace('pace://', '').split('?')[0].split('/')[0];
    const map = { newtab: 'newtab.html', settings: 'settings.html', downloads: 'downloads.html', extensions: 'extensions.html', history: 'history.html', tos: 'tos.html', privacy: 'privacy.html', passwords: 'passwords.html' };
    callback({ path: RENDERER(map[page] || 'newtab.html') });
  });
  applyNetworkRules();
  // Permissions: allow audio/video capture, tab audio capture, and media so extensions
  // like Shazam (which need to *hear* the page) and normal sites (mic/cam) can work.
  try {
    const ses = session.defaultSession;
    const GRANT = new Set(['media', 'audioCapture', 'videoCapture', 'mediaKeySystem', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'tabCapture', 'desktopCapture']);
    ses.setPermissionRequestHandler((wc, permission, callback) => {
      // Notifications/geolocation/etc. fall through to allowed too, but capture is the key one.
      callback(true);
    });
    ses.setPermissionCheckHandler((wc, permission) => {
      return GRANT.has(permission) ? true : true;
    });
    // When a page or extension requests getDisplayMedia / tabCapture, hand back the current tab's
    // media stream so audio recognition extensions receive the tab audio.
    if (typeof ses.setDisplayMediaRequestHandler === 'function') {
      ses.setDisplayMediaRequestHandler((request, callback) => {
        try {
          const src = (activeTabId && tabs[activeTabId]) ? tabs[activeTabId].webContents : null;
          // Provide video of the active tab plus 'loopback' audio so the tab's sound is captured.
          if (src) callback({ video: src, audio: 'loopback' });
          else callback({});
        } catch (e) { try { callback({}); } catch (_) {} }
      }, { useSystemPicker: false });
    }
  } catch (e) {}
  // Enable real Chrome Web Store installs (the store's "Add" button + programmatic installs),
  // plus persistence/reload of installed extensions — the way Electron browsers do it.
  if (webStore && webStore.installChromeWebStore) {
    try {
      await webStore.installChromeWebStore({
        session: session.defaultSession,
        extensionsPath: path.join(userDataPath, 'WebStoreExtensions'),
        loadExtensions: true,
        autoUpdate: false,
        allowUnpackedExtensions: true,
        minimumManifestVersion: 2,
      });
    } catch (e) { console.error('Web Store init failed:', e); }
  }
  await loadStoredExtensions();
  syncExtMeta();                 // record paths/metadata of everything that loaded
  await applyDisabledExtensions(); // unload anything the user had disabled
  refreshNewtabOverride();       // honor any extension that overrides the new-tab page
  createMainWindow();

  // If electron-chrome-extensions is installed, wire up the chrome.tabs / chrome.windows APIs so
  // extensions that open their own tabs and use the extension action APIs work. We map its tab
  // operations onto Pace's tab system.
  if (ElectronChromeExtensions && mainWindow) {
    try {
      const findTabId = (wc) => { try { return Object.keys(tabs).find(id => tabs[id] && tabs[id].webContents === wc); } catch (e) { return null; } };
      chromeExtensions = new ElectronChromeExtensions({
        // Modern versions REQUIRE a license string; without it the constructor throws and the
        // whole extension API layer silently fails to initialize.
        license: 'GPL-3.0',
        session: session.defaultSession,
        createTab: (details) => {
          const id = createTab(details && details.url ? details.url : 'pace://newtab', !(details && details.active !== false));
          const view = tabs[id];
          return Promise.resolve([view.webContents, mainWindow]);
        },
        selectTab: (tab) => { try { const id = findTabId(tab); if (id) switchTab(id); } catch (e) {} },
        removeTab: (tab) => { try { const id = findTabId(tab); if (id) closeTab(id); } catch (e) {} },
        createWindow: () => Promise.resolve(mainWindow),
        removeWindow: () => {},
        assignTabDetails: () => {},
      });
      // Register already-open tabs so the API sees them
      try { Object.keys(tabs).forEach(id => { if (tabs[id] && tabs[id].webContents) chromeExtensions.addTab(tabs[id].webContents, mainWindow); }); } catch (e) {}
    } catch (e) {
      chromeExtensions = null;
      // Surface the real reason so we can diagnose instead of failing silently.
      try { fs.appendFileSync(path.join(userDataPath, 'pace-extensions.log'), '[' + new Date().toISOString() + '] ElectronChromeExtensions init failed: ' + String(e && e.stack || e) + '\n'); } catch (_) {}
      console.error('[Pace] ElectronChromeExtensions init failed:', e);
    }
  } else {
    try { fs.appendFileSync(path.join(userDataPath, 'pace-extensions.log'), '[' + new Date().toISOString() + '] electron-chrome-extensions module ' + (ElectronChromeExtensions ? 'present' : 'NOT installed') + '\n'); } catch (_) {}
  }

  // Auto-update: download in the background and install on quit; re-check periodically.
  if (autoUpdater && app.isPackaged) {
    try {
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('update-available', (info) => sendToAll('update-status', { state: 'available', version: info && info.version }));
      autoUpdater.on('update-not-available', () => sendToAll('update-status', { state: 'none' }));
      autoUpdater.on('download-progress', (p) => sendToAll('update-status', { state: 'downloading', percent: Math.round((p && p.percent) || 0) }));
      autoUpdater.on('update-downloaded', (info) => { updateDownloadedVersion = (info && info.version) || updateDownloadedVersion; sendToAll('update-status', { state: 'downloaded', version: info && info.version }); });
      autoUpdater.on('error', (err) => sendToAll('update-status', { state: 'error', message: String(err && err.message || err) }));
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      setInterval(() => { try { autoUpdater.checkForUpdates().catch(() => {}); } catch (e) {} }, 6 * 60 * 60 * 1000);
    } catch (e) {}
  }
  // Offer to become the default browser (once), unless already default.
  setTimeout(() => { try { const s = loadSettings(); if (!s.askedDefault && !app.isDefaultProtocolClient('http')) sendToAll('ask-default-browser', {}); } catch (e) {} }, 4000);
});

app.on('window-all-closed', () => {
  const s = loadSettings();
  if (s.clearOnExit) { try { session.defaultSession.clearStorageData(); fs.writeFileSync(historyPath, '[]'); } catch (e) {} }
  if (process.platform !== 'darwin') app.quit();
});
app.on('web-contents-created', (e, contents) => {
  contents.on('will-navigate', (ev, url) => { if (url.startsWith('javascript:')) ev.preventDefault(); });
  // Reliable isDestroyed polyfill: patch the prototype of a real frame instance (covers older Electron)
  try {
    const f = contents.mainFrame;
    if (f) {
      const proto = Object.getPrototypeOf(f);
      if (proto && typeof proto.isDestroyed !== 'function') proto.isDestroyed = function () { try { return this.url === undefined; } catch (_) { return false; } };
    }
  } catch (_) {}
});
