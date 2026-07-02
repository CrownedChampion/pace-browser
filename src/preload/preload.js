const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pace', {
  // Window
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

  // Tabs / navigation
  navigate:     (url, tabId) => ipcRenderer.send('navigate', { url, tabId }),
  preloadUrl:   (url, opts) => ipcRenderer.send('preload-url', { url, force: !!(opts && opts.force) }),
  predictPreload: (prefix) => ipcRenderer.send('preload-predict', { prefix }),
  goBack:       () => ipcRenderer.send('go-back'),
  goForward:    () => ipcRenderer.send('go-forward'),
  reload:       () => ipcRenderer.send('reload'),
  stop:         () => ipcRenderer.send('stop-loading'),
  newTab:       (url) => ipcRenderer.send('new-tab', { url }),
  requestTabs:  () => ipcRenderer.send('request-tabs'),
  newTabBg:     (url) => ipcRenderer.send('new-tab-bg', { url }),
  switchTab:    (tabId) => ipcRenderer.send('switch-tab', { tabId }),
  closeTab:     (tabId) => ipcRenderer.send('close-tab', { tabId }),
  duplicateTab: (tabId) => ipcRenderer.send('duplicate-tab', { tabId }),
  showTabMenu:  (tabId) => ipcRenderer.send('show-tab-menu', { tabId }),

  // Layout (renderer-driven)
  setPageBounds:  (bounds) => ipcRenderer.send('set-page-bounds', { bounds }),
  capturePage:    () => ipcRenderer.invoke('capture-page'),
  setSidebarView: (payload) => ipcRenderer.send('set-sidebar-view', payload),
  openSettingsPanel:  (bounds) => ipcRenderer.send('open-settings-panel', { bounds }),
  closeSettingsPanel: () => ipcRenderer.send('close-settings-panel'),

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
  showBookmarkMenu: (index) => ipcRenderer.send('show-bookmark-menu', { index }),
  showOtherBookmarks: () => ipcRenderer.send('show-other-bookmarks'),
  getFavicon: (domain) => ipcRenderer.invoke('get-favicon', { domain }),

  // Downloads
  getDownloads:   () => ipcRenderer.invoke('get-downloads'),
  clearDownloads: () => ipcRenderer.send('clear-downloads'),
  removeDownload: (id) => ipcRenderer.send('remove-download', { id }),
  openFile:       (p) => ipcRenderer.send('open-file', { filePath: p }),
  showInFolder:   (p) => ipcRenderer.send('show-in-folder', { filePath: p }),
  chooseDownloadPath: () => ipcRenderer.invoke('choose-download-path'),

  // Extensions (real)
  getExtensions:        () => ipcRenderer.invoke('get-extensions'),
  installExtensionFolder: () => ipcRenderer.invoke('install-extension-folder'),
  installFromStore: (input) => ipcRenderer.invoke('install-from-store', { input }),
  setExtensionEnabled:  (id, enabled) => ipcRenderer.invoke('set-extension-enabled', { id, enabled }),
  openExtension:        (id) => ipcRenderer.invoke('open-extension-popup', { id }),
  removeExtension:      (id) => ipcRenderer.invoke('remove-extension', { id }),

  // Default browser + app version + auto-update
  appVersion: () => ipcRenderer.invoke('app-version'),
  getDefaultBrowserStatus: () => ipcRenderer.invoke('default-browser-status'),
  setDefaultBrowser: () => ipcRenderer.invoke('set-default-browser'),
  dismissDefaultPrompt: () => ipcRenderer.send('dismiss-default-prompt'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  quitAndInstall: () => ipcRenderer.send('quit-and-install'),

  // Pace Themes (.pacetheme)
  themesList:    () => ipcRenderer.invoke('themes-list'),
  themesActive:  () => ipcRenderer.invoke('themes-active'),
  themesApply:   (id) => ipcRenderer.invoke('themes-apply', id),
  themesReset:   () => ipcRenderer.invoke('themes-reset'),
  themesInstall: (doc) => ipcRenderer.invoke('themes-install', doc),
  themesRemove:  (id) => ipcRenderer.invoke('themes-remove', id),

  // Bookmarks bar: import + context menu
  importBookmarks: (source) => ipcRenderer.invoke('import-bookmarks', { source }),
  showBookmarksBarMenu: () => ipcRenderer.send('show-bookmarks-bar-menu'),

  // Misc
  openExternal: (url) => ipcRenderer.send('open-external', { url }),
  normalizeUrl: (url) => ipcRenderer.invoke('normalize-url', { url }),
  sharePage: (payload) => ipcRenderer.invoke('share-page', payload),
  getAddons: () => ipcRenderer.invoke('get-addons'),
  setAddonEnabled: (id, enabled) => ipcRenderer.invoke('set-addon-enabled', { id, enabled }),
  removeAddon: (id) => ipcRenderer.invoke('remove-addon', { id }),
  installAddonFolder: () => ipcRenderer.invoke('install-addon-folder'),
  installAddonFile: () => ipcRenderer.invoke('install-addon-file'),
  getSuggestions: (query) => ipcRenderer.invoke('search-suggestions', { query }),
  reopenClosedTab: () => ipcRenderer.send('reopen-closed-tab'),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  ready: () => ipcRenderer.send('chrome-ready'),
  mediaControl: (action) => ipcRenderer.send('media-control', { action }),
  mediaClose: () => ipcRenderer.send('media-close'),
  clearBrowsingData: () => ipcRenderer.invoke('clear-browsing-data'),
  pickElementToBlock: () => ipcRenderer.send('element-pick-start'),
  cancelElementPick: () => ipcRenderer.send('element-pick-cancel'),

  // Password manager (vault) — all crypto happens in the main process
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

  on: (channel, fn) => {
    const allowed = ['tab-created', 'tab-closed', 'tab-switched', 'tab-update', 'tab-loading', 'tabs-state',
      'download-started', 'download-progress', 'download-done', 'window-state', 'settings-changed', 'relayout', 'settings-panel-closed', 'bookmark-action', 'media-update', 'app-shortcut', 'sidebar-app-closed', 'update-status', 'ask-default-browser', 'bm-bar-action', 'theme-changed'];
    if (!allowed.includes(channel)) return;
    const w = (e, ...args) => fn(...args);
    ipcRenderer.on(channel, w);
    return () => ipcRenderer.removeListener(channel, w);
  },
});
