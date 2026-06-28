// Page preload for Pace's internal pages (newtab, settings, history, downloads,
// extensions, tos, privacy). These are loaded from file:// inside the renderer
// folder. We expose the `pace` bridge ONLY to those trusted internal pages —
// real websites (http/https) never receive it.
const { contextBridge, ipcRenderer } = require('electron');

// ─── Make login flows treat Pace as a normal Chrome ──────────────────────────────
// CRITICAL: with contextIsolation+sandbox, patching `navigator` in this preload's isolated
// world does NOT change what the PAGE sees — the page has its own main-world `navigator`.
// So we inject a <script> that runs in the page's own context and applies the fixes there.
// This addresses Google's "this browser or app may not be secure" and the passkey prompt
// that pops up while typing an email (Google calls credentials.get with conditional mediation).
(function injectMainWorldShim() {
  const code = `(() => {
    try {
      // 1) Hide the automation flag Google reads.
      try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }); } catch(e){}
      try { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); } catch(e){}

      // 2) Provide a believable window.chrome.runtime so headless/embedded detection passes.
      if (!window.chrome) { window.chrome = {}; }
      if (!window.chrome.runtime) {
        window.chrome.runtime = { id: undefined, connect: function(){ return { onMessage:{addListener:function(){}}, postMessage:function(){}, disconnect:function(){} }; }, sendMessage: function(){}, onMessage: { addListener: function(){} } };
      }
      if (!window.chrome.csi) window.chrome.csi = function(){ return {}; };
      if (!window.chrome.loadTimes) window.chrome.loadTimes = function(){ return {}; };
      if (!window.chrome.app) window.chrome.app = { isInstalled:false, getDetails:function(){return null;}, getIsInstalled:function(){return false;}, runningState:function(){return 'cannot_run';} };

      // 3) Realistic navigator surface (plugins, languages) so it doesn't look empty/headless.
      try { if (!navigator.languages || !navigator.languages.length) Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] }); } catch(e){}
      try {
        if (!navigator.plugins || navigator.plugins.length === 0) {
          const fake = [ { name:'Chrome PDF Plugin' }, { name:'Chrome PDF Viewer' }, { name:'Native Client' } ];
          Object.defineProperty(navigator, 'plugins', { get: () => fake });
        }
      } catch(e){}
      // 3b) Keep the client-hint JS API consistent with the UA string and the headers we send,
      //     so there's no version/brand mismatch for sign-in to flag.
      try {
        const brands = [ { brand:'Not_A Brand', version:'8' }, { brand:'Chromium', version:'120' }, { brand:'Google Chrome', version:'120' } ];
        const uaData = {
          brands: brands,
          mobile: false,
          platform: 'Windows',
          getHighEntropyValues: function(hints){ return Promise.resolve({ architecture:'x86', bitness:'64', brands:brands, fullVersionList:[ {brand:'Not_A Brand',version:'8.0.0.0'},{brand:'Chromium',version:'120.0.0.0'},{brand:'Google Chrome',version:'120.0.0.0'} ], mobile:false, model:'', platform:'Windows', platformVersion:'10.0.0', uaFullVersion:'120.0.0.0' }); },
          toJSON: function(){ return { brands:brands, mobile:false, platform:'Windows' }; }
        };
        try { Object.defineProperty(navigator, 'userAgentData', { get: () => uaData, configurable: true }); } catch(e){}
      } catch(e){}

      // 4) Stop the conditional passkey/Hello prompt that auto-opens while typing the email field.
      //    Only the 'conditional' (autofill) form is suppressed; explicit passkey buttons still work.
      try {
        if (navigator.credentials && navigator.credentials.get) {
          const _get = navigator.credentials.get.bind(navigator.credentials);
          navigator.credentials.get = function(opts){
            try {
              if (opts && (opts.mediation === 'conditional' || (opts.publicKey && opts.mediation === 'conditional'))) {
                // Return a promise that never resolves and never rejects -> no popup, no page error.
                return new Promise(function(){});
              }
            } catch(e){}
            return _get(opts);
          };
        }
        // Also report conditional-mediation as unavailable so sites don't even try.
        try {
          if (window.PublicKeyCredential) {
            window.PublicKeyCredential.isConditionalMediationAvailable = function(){ return Promise.resolve(false); };
          }
        } catch(e){}
      } catch(e){}
    } catch(e){}
  })();`;
  try {
    const inject = () => {
      try {
        const root = document.documentElement || document.head || document.body;
        if (!root) return false;
        const s = document.createElement('script');
        s.textContent = code;
        root.insertBefore(s, root.firstChild);
        s.remove();
        return true;
      } catch (e) { return false; }
    };
    // Try immediately; if the document isn't ready yet, poll briefly until it is (still before
    // the page's own scripts run in practice), then stop.
    if (!inject()) {
      let tries = 0;
      const iv = setInterval(() => {
        tries++;
        if (inject() || tries > 200) clearInterval(iv);
      }, 0);
      document.addEventListener('DOMContentLoaded', () => { inject(); clearInterval(iv); }, true);
    }
  } catch (e) {}
})();

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

    // Addons (Pace Addon manager — pace://extensions)
    getAddons:           () => ipcRenderer.invoke('get-addons'),
    setAddonEnabled:     (id, enabled) => ipcRenderer.invoke('set-addon-enabled', { id, enabled }),
    removeAddon:         (id) => ipcRenderer.invoke('remove-addon', { id }),
    installAddonFolder:  () => ipcRenderer.invoke('install-addon-folder'),
    installAddonFile:    () => ipcRenderer.invoke('install-addon-file'),
    openExtension:       (id) => ipcRenderer.invoke('open-extension-popup', { id }),

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
    themesList:    () => ipcRenderer.invoke('themes-list'),
    themesActive:  () => ipcRenderer.invoke('themes-active'),
    themesApply:   (id) => ipcRenderer.invoke('themes-apply', id),
    themesReset:   () => ipcRenderer.invoke('themes-reset'),
    themesInstall: (doc) => ipcRenderer.invoke('themes-install', doc),
    themesRemove:  (id) => ipcRenderer.invoke('themes-remove', id),
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
        // In-page unlock: master password (and Hello if available) right here, no redirect.
        const head = document.createElement('div');
        head.textContent = '🔒 Unlock Pace to fill';
        head.style.cssText = 'padding:10px 14px;font-size:12px;color:#f1f1fb;border-bottom:1px solid rgba(255,255,255,.08)';
        dropdown.appendChild(head);

        const wrap = document.createElement('div');
        wrap.style.cssText = 'padding:12px 14px;display:flex;flex-direction:column;gap:8px';
        const inp = document.createElement('input');
        inp.type = 'password'; inp.placeholder = 'Master password';
        inp.style.cssText = 'width:100%;box-sizing:border-box;height:36px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:#0e0e16;color:#f1f1fb;padding:0 10px;font-size:13px;outline:none';
        // keep clicks/keys inside our UI from bubbling to the page
        ['mousedown','click','keydown','keyup','keypress'].forEach(ev => inp.addEventListener(ev, e => e.stopPropagation()));
        const err = document.createElement('div');
        err.style.cssText = 'color:#f0556e;font-size:11.5px;min-height:0;display:none';
        const btn = document.createElement('button');
        btn.textContent = 'Unlock & fill';
        btn.style.cssText = 'height:36px;border:none;border-radius:8px;cursor:pointer;background:linear-gradient(135deg,#5b8ef0,#a78bfa);color:#fff;font-size:13px;font-family:inherit';
        const doUnlock = async () => {
          const pw = inp.value;
          if (!pw) return;
          btn.textContent = 'Unlocking…'; btn.disabled = true;
          const u = await ipcRenderer.invoke('autofill-unlock', { masterPassword: pw });
          if (u && u.ok) { removeDropdown(); showSuggestions(pwField); }
          else { err.textContent = (u && u.reason) || 'Incorrect password.'; err.style.display = 'block'; btn.textContent = 'Unlock & fill'; btn.disabled = false; inp.select(); }
        };
        btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); doUnlock(); });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doUnlock(); } });
        wrap.appendChild(inp); wrap.appendChild(err); wrap.appendChild(btn);

        // Optional Windows Hello button
        if (q.helloEnabled) {
          const hbtn = document.createElement('button');
          hbtn.textContent = '👋 Use Windows Hello';
          hbtn.style.cssText = 'height:36px;border:1px solid rgba(255,255,255,.16);border-radius:8px;cursor:pointer;background:rgba(255,255,255,.06);color:#f1f1fb;font-size:13px;font-family:inherit';
          hbtn.addEventListener('mousedown', async (e) => {
            e.preventDefault(); e.stopPropagation();
            hbtn.textContent = 'Waiting for Hello…'; hbtn.disabled = true;
            const u = await ipcRenderer.invoke('autofill-hello-unlock');
            if (u && u.ok) { removeDropdown(); showSuggestions(pwField); }
            else { err.textContent = (u && u.reason) || 'Hello failed.'; err.style.display = 'block'; hbtn.textContent = '👋 Use Windows Hello'; hbtn.disabled = false; }
          });
          wrap.appendChild(hbtn);
        }
        dropdown.appendChild(wrap);
        document.body.appendChild(dropdown);
        setTimeout(() => { try { inp.focus(); } catch (e) {} }, 30);
        return;
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
      // Focus landing INSIDE our own autofill UI (e.g. the in-dropdown master-password box)
      // must NOT be treated as a page login field — otherwise we'd rebuild the dropdown and it
      // would reset on every focus, making it impossible to type the password or click Unlock.
      if (t && t.closest && t.closest('[data-pace-autofill]')) return;
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
      // Only prompt when this is a NEW login or the password CHANGED — never nag for an unchanged one.
      let isUpdate = false;
      try {
        const chk = await ipcRenderer.invoke('autofill-save-check', { username: user, password: pass });
        if (chk && chk.offer === false) { removeSaveBar(); return; }
        isUpdate = !!(chk && chk.isUpdate);
      } catch (e) {}
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
      title.textContent = isUpdate ? '🔐 Update saved password in Pace?' : '🔐 Save this password in Pace?';
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
      let dismissT = null;
      const showSaved = () => { try { title.textContent = '✓ Saved to Pace'; sub.textContent = (lastUser ? lastUser + ' · ' : '') + location.hostname; btns.innerHTML = ''; } catch (e) {} if (dismissT) clearTimeout(dismissT); setTimeout(removeSaveBar, 1400); };
      const trySave = async () => {
        const r = await ipcRenderer.invoke('autofill-save', { username: lastUser, password: lastPass });
        if (r && r.ok) { showSaved(); }
        else if (r && r.reason === 'locked') { showSaveUnlock(); }
        else { removeSaveBar(); }
      };
      async function showSaveUnlock() {
        if (dismissT) clearTimeout(dismissT);   // don't auto-close while they're typing the master password
        let helloEnabled = false; try { const q = await ipcRenderer.invoke('autofill-query'); helloEnabled = !!(q && q.helloEnabled); } catch (e) {}
        title.textContent = '🔒 Unlock Pace to save';
        btns.innerHTML = ''; btns.style.flexDirection = 'column'; btns.style.alignItems = 'stretch';
        const inp = document.createElement('input'); inp.type = 'password'; inp.placeholder = 'Master password';
        inp.style.cssText = 'width:100%;box-sizing:border-box;height:34px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:#0e0e16;color:#f1f1fb;padding:0 10px;font-size:13px;outline:none;margin-bottom:8px';
        ['mousedown', 'click', 'keydown', 'keyup', 'keypress'].forEach(ev => inp.addEventListener(ev, e => e.stopPropagation()));
        const err = document.createElement('div'); err.style.cssText = 'color:#f0556e;font-size:11.5px;display:none;margin-bottom:8px';
        const ub = mk('Unlock & save', true); ub.style.width = '100%';
        const doUnlock = async () => { const pw = inp.value; if (!pw) return; ub.textContent = 'Unlocking…'; ub.disabled = true; const u = await ipcRenderer.invoke('autofill-unlock', { masterPassword: pw }); if (u && u.ok) { await trySave(); } else { err.textContent = (u && u.reason) || 'Incorrect password.'; err.style.display = 'block'; ub.textContent = 'Unlock & save'; ub.disabled = false; inp.select(); } };
        ub.addEventListener('click', doUnlock); inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doUnlock(); } });
        btns.appendChild(inp); btns.appendChild(err); btns.appendChild(ub);
        if (helloEnabled) { const hb = mk('👋 Use Windows Hello', false); hb.style.cssText += ';width:100%;margin-top:8px'; hb.addEventListener('click', async () => { hb.textContent = 'Waiting for Hello…'; hb.disabled = true; const u = await ipcRenderer.invoke('autofill-hello-unlock'); if (u && u.ok) { await trySave(); } else { err.textContent = (u && u.reason) || 'Hello failed.'; err.style.display = 'block'; hb.textContent = '👋 Use Windows Hello'; hb.disabled = false; } }); btns.appendChild(hb); }
        setTimeout(() => { try { inp.focus(); } catch (e) {} }, 30);
      }
      yes.addEventListener('click', trySave);
      btns.appendChild(no); btns.appendChild(yes);
      saveBar.appendChild(title); saveBar.appendChild(sub); saveBar.appendChild(btns);
      document.body.appendChild(saveBar);
      dismissT = setTimeout(() => { if (saveBar) removeSaveBar(); }, 12000);
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

      // ── Element blocker / picker ──
      let picking = false, hi = null;
      function cssSelector(el) {
        if (!el || el === document.body) return 'body';
        if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
        let path = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.body && path.length < 5) {
          let part = node.tagName.toLowerCase();
          const cls = (node.className && typeof node.className === 'string')
            ? node.className.trim().split(/\s+/).filter(c => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2) : [];
          if (cls.length) part += '.' + cls.join('.');
          else {
            const parent = node.parentNode;
            if (parent) { const idx = Array.prototype.indexOf.call(parent.children, node) + 1; part += ':nth-child(' + idx + ')'; }
          }
          path.unshift(part);
          if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) { path.unshift('#' + node.id); break; }
          node = node.parentNode;
        }
        return path.join(' > ');
      }
      function ensureHi() {
        if (hi) return hi;
        hi = document.createElement('div');
        hi.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:rgba(91,142,240,.25);border:2px solid #5b8ef0;border-radius:4px;transition:all .05s';
        document.documentElement.appendChild(hi);
        return hi;
      }
      function onPickMove(e) {
        if (!picking) return;
        const el = e.target; if (!el) return;
        const r = el.getBoundingClientRect();
        const h = ensureHi();
        h.style.left = r.left + 'px'; h.style.top = r.top + 'px'; h.style.width = r.width + 'px'; h.style.height = r.height + 'px';
      }
      function stopPicking() {
        picking = false;
        document.removeEventListener('mousemove', onPickMove, true);
        document.removeEventListener('click', onPickClick, true);
        document.removeEventListener('keydown', onPickKey, true);
        if (hi && hi.parentNode) hi.parentNode.removeChild(hi); hi = null;
      }
      async function onPickClick(e) {
        if (!picking) return;
        e.preventDefault(); e.stopPropagation();
        const el = e.target;
        const sel = cssSelector(el);
        try { el.style.setProperty('display', 'none', 'important'); } catch (err) {}
        try { await ipcRenderer.invoke('element-block-add', { host: location.hostname, selector: sel }); } catch (err) {}
        stopPicking();
      }
      function onPickKey(e) { if (e.key === 'Escape') { e.preventDefault(); stopPicking(); } }
      function startPicking() {
        if (picking) return;
        picking = true;
        document.addEventListener('mousemove', onPickMove, true);
        document.addEventListener('click', onPickClick, true);
        document.addEventListener('keydown', onPickKey, true);
      }
      ipcRenderer.on('pace-pick-element', () => startPicking());
      ipcRenderer.on('pace-cancel-pick', () => { try { stopPicking(); } catch (e) {} });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  })();
}
