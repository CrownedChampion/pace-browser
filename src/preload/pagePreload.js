// Page preload for Pace's internal pages (newtab, settings, history, downloads,
// extensions, tos, privacy). These are loaded from file:// inside the renderer
// folder. We expose the `pace` bridge ONLY to those trusted internal pages —
// real websites (http/https) never receive it.
const { contextBridge, ipcRenderer } = require('electron');

function isInternalPacePage() {
  try {
    const loc = window.location || {};
    if (loc.protocol !== 'file:') return false;
    const href = decodeURIComponent(loc.href || '');
    return href.indexOf('/renderer/') !== -1 || /[\\/]renderer[\\/]/i.test(href);
  } catch (e) { return false; }
}

if (isInternalPacePage()) {
  contextBridge.exposeInMainWorld('pace', {
    // Window
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close:    () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

    // Tabs / navigation
    navigate:     (url, tabId) => ipcRenderer.send('navigate', { url, tabId }),
    preloadUrl:   (url, opts) => ipcRenderer.send('preload-url', { url, force: !!(opts && opts.force) }),
    goBack:       () => ipcRenderer.send('go-back'),
    goForward:    () => ipcRenderer.send('go-forward'),
    reload:       () => ipcRenderer.send('reload'),
    stop:         () => ipcRenderer.send('stop-loading'),
    newTab:       (url) => ipcRenderer.send('new-tab', { url }),
    newTabBg:     (url) => ipcRenderer.send('new-tab-bg', { url }),
    switchTab:    (tabId) => ipcRenderer.send('switch-tab', { tabId }),
    closeTab:     (tabId) => ipcRenderer.send('close-tab', { tabId }),
    duplicateTab: (tabId) => ipcRenderer.send('duplicate-tab', { tabId }),
    showTabMenu:  (tabId) => ipcRenderer.send('show-tab-menu', { tabId }),

    // Settings
    getSettings:  () => ipcRenderer.invoke('get-settings'),
    saveSettings: (s) => ipcRenderer.send('save-settings', s),

    // History
    getHistory:        () => ipcRenderer.invoke('get-history'),
    clearHistory:      () => ipcRenderer.send('clear-history'),
    removeHistoryItem: (url, time) => ipcRenderer.send('remove-history-item', { url, time }),

    // Bookmarks
    getBookmarks:  () => ipcRenderer.invoke('get-bookmarks'),
    saveBookmarks: (b) => ipcRenderer.send('save-bookmarks', b),
    clearBookmarks: (scope) => ipcRenderer.invoke('clear-bookmarks', { scope }),

    // Downloads
    getDownloads:   () => ipcRenderer.invoke('get-downloads'),
    clearDownloads: () => ipcRenderer.send('clear-downloads'),
    openFile:       (p) => ipcRenderer.send('open-file', { filePath: p }),
    showInFolder:   (p) => ipcRenderer.send('show-in-folder', { filePath: p }),
    chooseDownloadPath: () => ipcRenderer.invoke('choose-download-path'),

    // Extensions (real)
    getExtensions:          () => ipcRenderer.invoke('get-extensions'),
    installExtensionFolder: () => ipcRenderer.invoke('install-extension-folder'),
    installFromStore: (input) => ipcRenderer.invoke('install-from-store', { input }),
    setExtensionEnabled:    (id, enabled) => ipcRenderer.invoke('set-extension-enabled', { id, enabled }),
    removeExtension:        (id) => ipcRenderer.invoke('remove-extension', { id }),

    // Misc
    openExternal: (url) => ipcRenderer.send('open-external', { url }),
    getFavicon: (domain) => ipcRenderer.invoke('get-favicon', { domain }),
    closeSettings: () => ipcRenderer.send('close-settings-panel'),
    normalizeUrl: (url) => ipcRenderer.invoke('normalize-url', { url }),
    clearBrowsingData: () => ipcRenderer.invoke('clear-browsing-data'),

    // Default browser + app version + auto-update (used by the settings page)
    appVersion: () => ipcRenderer.invoke('app-version'),
    getDefaultBrowserStatus: () => ipcRenderer.invoke('default-browser-status'),
    setDefaultBrowser: () => ipcRenderer.invoke('set-default-browser'),
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    quitAndInstall: () => ipcRenderer.send('quit-and-install'),
    importBookmarks: (source) => ipcRenderer.invoke('import-bookmarks', { source }),

    // Password manager (vault) — crypto runs in the main process
    vaultStatus: () => ipcRenderer.invoke('vault-status'),
    vaultCreate: (masterPassword) => ipcRenderer.invoke('vault-create', { masterPassword }),
    vaultUnlock: (masterPassword) => ipcRenderer.invoke('vault-unlock', { masterPassword }),
    vaultLock: () => ipcRenderer.invoke('vault-lock'),
    vaultList: (reveal) => ipcRenderer.invoke('vault-list', { reveal }),
    vaultGetPassword: (id) => ipcRenderer.invoke('vault-get-password', { id }),
    vaultSaveEntry: (entry) => ipcRenderer.invoke('vault-save-entry', entry),
    vaultDeleteEntry: (id) => ipcRenderer.invoke('vault-delete-entry', { id }),
    vaultChangeMaster: (currentPassword, newPassword) => ipcRenderer.invoke('vault-change-master', { currentPassword, newPassword }),
    vaultGenerate: (length) => ipcRenderer.invoke('vault-generate', { length }),
    vaultImportCsv: () => ipcRenderer.invoke('vault-import-csv'),
    helloStatus: () => ipcRenderer.invoke('hello-status'),
    helloEnable: () => ipcRenderer.invoke('hello-enable'),
    helloDisable: () => ipcRenderer.invoke('hello-disable'),
    helloUnlock: () => ipcRenderer.invoke('hello-unlock'),

    on: (channel, fn) => {
      const allowed = ['tab-created', 'tab-closed', 'tab-switched', 'tab-update', 'tab-loading',
        'download-started', 'download-progress', 'download-done', 'window-state', 'settings-changed', 'relayout', 'update-status'];
      if (!allowed.includes(channel)) return;
      const w = (e, ...args) => fn(...args);
      ipcRenderer.on(channel, w);
      return () => ipcRenderer.removeListener(channel, w);
    },
  });
}

// ─── Autofill content script (runs on real web pages, main frame only) ───────────
// This runs in the preload's ISOLATED world: the page's own JavaScript cannot see any
// of these variables, the ipcRenderer handle, or read the credentials we fetch. We only
// touch the shared DOM (to find login fields, draw a small suggestion dropdown, and fill
// values). Passwords are requested from main ONLY on an explicit user click, and main
// verifies the site origin before returning anything.
else if (window.top === window) {
  (function () {
    let enabled = true;
    let dropdown = null;
    let activeField = null;
    let lastUser = '', lastPass = '';

    function isVisible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const st = window.getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
    }
    function passwordFields() {
      return Array.prototype.slice.call(document.querySelectorAll('input[type="password"]')).filter(isVisible);
    }
    // Find the username/email field most likely paired with a given password field
    // (the nearest preceding text/email/tel field within the same form).
    function userFieldFor(pwField) {
      const scope = pwField.form || document;
      const cands = Array.prototype.slice.call(scope.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input:not([type])'
      )).filter(isVisible);
      if (!cands.length) return null;
      // Prefer ones whose name/id/autocomplete hint at username/email
      const hinted = cands.find(c => /user|email|login|account|mail/i.test((c.name || '') + (c.id || '') + (c.autocomplete || '')));
      if (hinted) return hinted;
      // else the field visually closest above the password field
      let best = null, bestDist = Infinity;
      const pr = pwField.getBoundingClientRect();
      cands.forEach(c => {
        const cr = c.getBoundingClientRect();
        const d = pr.top - cr.top;
        if (d >= 0 && d < bestDist) { bestDist = d; best = c; }
      });
      return best || cands[0];
    }

    function removeDropdown() { if (dropdown && dropdown.parentNode) dropdown.parentNode.removeChild(dropdown); dropdown = null; }

    function setNativeValue(el, value) {
      // Set the value in a way frameworks (React/Vue) detect.
      try {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, value); else el.value = value;
      } catch (e) { el.value = value; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function fillEntry(id, pwField) {
      const r = await ipcRenderer.invoke('autofill-fill', { id });
      if (!r || !r.ok) { return; }
      const uf = userFieldFor(pwField);
      if (uf && r.username) setNativeValue(uf, r.username);
      if (r.password) setNativeValue(pwField, r.password);
      removeDropdown();
    }

    async function showSuggestions(pwField) {
      if (!enabled) return;
      const q = await ipcRenderer.invoke('autofill-query');
      if (!q || !q.ok) return;
      removeDropdown();
      const r = pwField.getBoundingClientRect();
      dropdown = document.createElement('div');
      dropdown.setAttribute('data-pace-autofill', '1');
      dropdown.style.cssText = [
        'position:absolute', 'z-index:2147483647',
        'left:' + (window.scrollX + r.left) + 'px',
        'top:' + (window.scrollY + r.bottom + 4) + 'px',
        'min-width:' + Math.max(220, r.width) + 'px',
        'background:#15151f', 'color:#f1f1fb', 'border:1px solid rgba(255,255,255,.14)',
        'border-radius:10px', 'box-shadow:0 12px 34px rgba(0,0,0,.5)', 'overflow:hidden',
        'font-family:-apple-system,Segoe UI,Roboto,sans-serif', 'font-size:13px'
      ].join(';');

      if (!q.unlocked) {
        if (!q.hasMatches) { removeDropdown(); return; }
        const row = document.createElement('div');
        row.textContent = '🔒 Unlock Pace to fill saved logins';
        row.style.cssText = 'padding:11px 14px;cursor:pointer;color:#9d9dc8';
        row.addEventListener('mousedown', (e) => { e.preventDefault(); ipcRenderer.send('navigate', { url: 'pace://passwords' }); removeDropdown(); });
        dropdown.appendChild(row);
      } else if (q.matches && q.matches.length) {
        const head = document.createElement('div');
        head.textContent = 'Pace · saved logins';
        head.style.cssText = 'padding:8px 14px;font-size:11px;color:#5c5c7e;border-bottom:1px solid rgba(255,255,255,.08)';
        dropdown.appendChild(head);
        q.matches.forEach(m => {
          const row = document.createElement('div');
          row.style.cssText = 'padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:10px';
          row.innerHTML = '<span style="width:26px;height:26px;border-radius:6px;background:rgba(91,142,240,.18);color:#5b8ef0;display:flex;align-items:center;justify-content:center;font-weight:700">'
            + (((m.username || m.site || '?').trim()[0] || '?').toUpperCase()) + '</span>';
          const label = document.createElement('div');
          label.textContent = m.username || m.site || '(saved login)';
          label.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
          row.appendChild(label);
          row.addEventListener('mouseenter', () => row.style.background = 'rgba(255,255,255,.06)');
          row.addEventListener('mouseleave', () => row.style.background = 'transparent');
          // mousedown (not click) so it fires before the field blurs
          row.addEventListener('mousedown', (e) => { e.preventDefault(); fillEntry(m.id, pwField); });
          dropdown.appendChild(row);
        });
      } else { removeDropdown(); return; }

      document.body.appendChild(dropdown);
    }

    function onFocusIn(e) {
      const t = e.target;
      if (t && t.tagName === 'INPUT' && t.type === 'password' && isVisible(t)) {
        activeField = t;
        showSuggestions(t);
      }
    }
    function onDocClick(e) {
      if (dropdown && !dropdown.contains(e.target) && e.target !== activeField) removeDropdown();
    }

    // ── Offer to save on submit ──
    let saveBar = null;
    function removeSaveBar() { if (saveBar && saveBar.parentNode) saveBar.parentNode.removeChild(saveBar); saveBar = null; }
    async function offerSave() {
      if (!enabled) return;
      const pf = passwordFields()[0];
      if (!pf) return;
      const pass = pf.value;
      if (!pass || pass.length < 3) return;
      const uf = userFieldFor(pf);
      const user = uf ? uf.value : '';
      // Don't offer if main says this exact login is already saved (handled by de-dupe on save too).
      lastUser = user; lastPass = pass;
      removeSaveBar();
      saveBar = document.createElement('div');
      saveBar.setAttribute('data-pace-autofill', '1');
      saveBar.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'right:18px', 'bottom:18px', 'max-width:340px',
        'background:#15151f', 'color:#f1f1fb', 'border:1px solid rgba(255,255,255,.14)',
        'border-radius:12px', 'box-shadow:0 14px 40px rgba(0,0,0,.5)', 'padding:14px 16px',
        'font-family:-apple-system,Segoe UI,Roboto,sans-serif', 'font-size:13.5px'
      ].join(';');
      const title = document.createElement('div');
      title.textContent = '🔐 Save this password in Pace?';
      title.style.cssText = 'font-weight:600;margin-bottom:4px';
      const sub = document.createElement('div');
      sub.textContent = (user ? (user + ' · ') : '') + location.hostname;
      sub.style.cssText = 'color:#9d9dc8;font-size:12px;margin-bottom:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
      const mk = (label, primary) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'border:none;cursor:pointer;border-radius:8px;padding:8px 14px;font-size:13px;font-family:inherit;' + (primary ? 'background:linear-gradient(135deg,#5b8ef0,#a78bfa);color:#fff' : 'background:rgba(255,255,255,.08);color:#f1f1fb'); return b; };
      const no = mk('Not now', false);
      const yes = mk('Save', true);
      no.addEventListener('click', removeSaveBar);
      yes.addEventListener('click', async () => { await ipcRenderer.invoke('autofill-save', { username: lastUser, password: lastPass }); removeSaveBar(); });
      btns.appendChild(no); btns.appendChild(yes);
      saveBar.appendChild(title); saveBar.appendChild(sub); saveBar.appendChild(btns);
      document.body.appendChild(saveBar);
      setTimeout(() => { if (saveBar) removeSaveBar(); }, 12000);
    }

    function init() {
      ipcRenderer.invoke('autofill-enabled').then(r => { enabled = !(r && r.enabled === false); }).catch(() => {});
      document.addEventListener('focusin', onFocusIn, true);
      document.addEventListener('click', onDocClick, true);
      // Capture submits (covers most login forms)
      document.addEventListener('submit', () => { setTimeout(offerSave, 50); }, true);
      // Also catch button-click logins that don't fire a real submit
      document.addEventListener('click', (e) => {
        const t = e.target;
        if (t && (t.type === 'submit' || /log\s*in|sign\s*in|continue|next/i.test(t.textContent || ''))) {
          setTimeout(offerSave, 400);
        }
      }, true);
      window.addEventListener('scroll', removeDropdown, true);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  })();
}
