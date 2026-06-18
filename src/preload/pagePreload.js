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
