// ─── Pace Addon runtime (Phase 1) ───────────────────────────────────────────────
// Pace Addons are Pace's own native addon format. Unlike Chrome MV3 extensions — whose core logic
// lives in a background service worker that cannot run on Electron — a Pace Addon declares what it
// does in `addon.json` and the browser drives it directly. Phase 1 supports the three capabilities
// that make an addon genuinely useful with no service worker required:
//   • cosmetic CSS         ("hide": ["selector", ...]  and/or  "styles": ["file.css"])
//   • content scripts      ("content_scripts": [{ "matches", "js", "css", "run_at" }])
//   • network block rules  ("block": ["substr", ...]   and/or  "block_hosts": ["host", ...])
// (Background pages and toolbar popups are the next increment and are read but not yet executed.)
//
// Layout of an addon (a folder, distributable as a .paceaddon zip later):
//   my-addon/
//   ├── addon.json     (manifest: id, name, version, description, author, permissions, matches, ...)
//   ├── content.js     (optional)
//   ├── style.css      (optional)
//   └── icon.png       (optional)

const fs = require('fs');
const path = require('path');

let USER_DIR = null;        // <userData>/PaceAddons        (installed addons live here)
let BUILTIN_DIR = null;     // <appPath>/builtin-addons      (addons shipped with Pace, read-only)
let REGISTRY_FILE = null;   // <userData>/pace-addons.json   (enabled/disabled state)
let registry = { enabled: {} };
let addons = [];            // [{ id, name, version, description, author, dir, builtin, manifest }]

function init({ userDataPath, appPath }) {
  try {
    USER_DIR = path.join(userDataPath, 'PaceAddons');
    BUILTIN_DIR = path.join(appPath || '', 'builtin-addons');
    REGISTRY_FILE = path.join(userDataPath, 'pace-addons.json');
    try { fs.mkdirSync(USER_DIR, { recursive: true }); } catch (e) {}
    loadRegistry();
    reload();
  } catch (e) { addons = []; }
}

function loadRegistry() {
  try { registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) || { enabled: {} }; }
  catch (e) { registry = { enabled: {} }; }
  if (!registry.enabled) registry.enabled = {};
}
function saveRegistry() {
  try { if (REGISTRY_FILE) fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf8'); } catch (e) {}
}

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'addon.json'), 'utf8'));
    if (!m || !m.id || !m.name) return null;
    return m;
  } catch (e) { return null; }
}

function scanDir(base, builtin) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(base, ent.name);
    const m = readManifest(dir);
    if (!m) continue;
    out.push({
      id: String(m.id), name: String(m.name), version: String(m.version || '1.0.0'),
      description: String(m.description || ''), author: String(m.author || ''),
      dir, builtin: !!builtin, manifest: m
    });
  }
  return out;
}

function reload() {
  const builtins = scanDir(BUILTIN_DIR, true);
  const users = scanDir(USER_DIR, false);
  const byId = {};
  for (const a of builtins) byId[a.id] = a;     // user addons override a built-in of the same id
  for (const a of users) byId[a.id] = a;
  addons = Object.values(byId);
  for (const a of addons) { if (registry.enabled[a.id] === undefined) registry.enabled[a.id] = true; }
  saveRegistry();
}

function isEnabled(id) { return registry.enabled[id] !== false; }
function enabledAddons() { return addons.filter(a => isEnabled(a.id)); }

// ── URL matching: supports "<all_urls>" and glob patterns like "*://*.example.com/*" ──
function matchOne(pattern, url) {
  if (!pattern) return false;
  if (pattern === '<all_urls>') return /^(https?|file):/i.test(url);
  const rx = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
  try { return new RegExp(rx, 'i').test(url); } catch (e) { return false; }
}
function matchesAny(patterns, url) {
  if (!Array.isArray(patterns) || !patterns.length) return false;
  for (const p of patterns) if (matchOne(p, url)) return true;
  return false;
}

function readFiles(dir, files) {
  let out = '';
  if (!Array.isArray(files)) return out;
  for (const f of files) {
    try {
      const full = path.resolve(dir, f);
      if (!full.startsWith(path.resolve(dir))) continue;   // never read outside the addon folder
      out += '\n' + fs.readFileSync(full, 'utf8');
    } catch (e) {}
  }
  return out;
}

// ── Providers consumed by main.js ──
function cssForUrl(url) {
  let css = '';
  for (const a of enabledAddons()) {
    const m = a.manifest;
    const scope = Array.isArray(m.matches) ? m.matches : ['<all_urls>'];
    if (matchesAny(scope, url)) {
      if (Array.isArray(m.hide) && m.hide.length) css += '\n' + m.hide.join(',\n') + '{display:none !important}';
      if (Array.isArray(m.styles)) css += readFiles(a.dir, m.styles);
    }
    for (const cs of (m.content_scripts || [])) {
      if (matchesAny(Array.isArray(cs.matches) ? cs.matches : scope, url)) css += readFiles(a.dir, cs.css);
    }
  }
  return css;
}
function contentScriptsForUrl(url) {
  const scripts = [];
  for (const a of enabledAddons()) {
    const m = a.manifest;
    const scope = Array.isArray(m.matches) ? m.matches : ['<all_urls>'];
    for (const cs of (m.content_scripts || [])) {
      if (matchesAny(Array.isArray(cs.matches) ? cs.matches : scope, url)) {
        const code = readFiles(a.dir, cs.js);
        if (code.trim()) scripts.push(code);
      }
    }
  }
  return scripts;
}
function networkRules() {
  const patterns = [], hosts = [];
  for (const a of enabledAddons()) {
    const m = a.manifest;
    if (Array.isArray(m.block)) for (const p of m.block) if (typeof p === 'string') patterns.push(p.toLowerCase());
    if (Array.isArray(m.block_hosts)) for (const h of m.block_hosts) if (typeof h === 'string') hosts.push(h.toLowerCase());
  }
  return { patterns, hosts };
}

// ── Management (driven by IPC from the Addon Shop UI) ──
function list() {
  return addons.map(a => ({
    id: a.id, name: a.name, version: a.version, description: a.description,
    author: a.author, builtin: a.builtin, enabled: isEnabled(a.id),
    permissions: Array.isArray(a.manifest.permissions) ? a.manifest.permissions : []
  }));
}
function setEnabled(id, enabled) { registry.enabled[id] = !!enabled; saveRegistry(); return { ok: true }; }
function remove(id) {
  const a = addons.find(x => x.id === id);
  if (!a) return { ok: false, reason: 'Addon not found.' };
  if (a.builtin) return { ok: false, reason: 'Built-in addons can be disabled but not removed.' };
  try { fs.rmSync(a.dir, { recursive: true, force: true }); }
  catch (e) { return { ok: false, reason: 'Could not delete the addon files.' }; }
  delete registry.enabled[id]; saveRegistry(); reload();
  return { ok: true };
}
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
function installFromFolder(srcDir) {
  const m = readManifest(srcDir);
  if (!m) return { ok: false, reason: 'That folder has no valid addon.json (needs at least an "id" and "name").' };
  const id = String(m.id);
  const dest = path.join(USER_DIR, id.replace(/[^a-z0-9_.-]/gi, '_'));
  try { fs.rmSync(dest, { recursive: true, force: true }); copyDir(srcDir, dest); }
  catch (e) { return { ok: false, reason: 'Could not copy the addon into Pace.' }; }
  registry.enabled[id] = true; saveRegistry(); reload();
  return { ok: true, id, name: String(m.name) };
}

module.exports = {
  init, reload, list, setEnabled, remove, installFromFolder,
  cssForUrl, contentScriptsForUrl, networkRules
};
