'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Pace Themes  —  a dedicated theme system, separate from the .paceaddon format.
//
//  A theme restyles the BROWSER ITSELF (its chrome: toolbar, tabs, menus, sidebar),
//  not web pages. It is its own file type: ".pacetheme" — a single JSON document.
//
//  ── .pacetheme format (v1) ──────────────────────────────────────────────────
//  {
//    "pacetheme": 1,                 // format version (required, must be 1)
//    "id":        "obsidian-gold",   // unique slug  [a-z0-9-_.]  (required)
//    "name":      "Obsidian Gold",   // display name (required)
//    "version":   "1.0.0",
//    "author":    "Pace",
//    "description":"Black glass, warm gold.",
//    "mode":      "dark",            // "dark" | "light" — the base the palette targets
//    "design": {                     // every key optional; omitted keys keep the mode default
//      "accent":    "#d8b46a",       // → --acc   (also derives --acc-soft / --acc-glow)
//      "accent2":   "#f0d488",       // → --acc2
//      "bg0":       "#0a0a0c",       // → --bg0   (window backdrop, dark end)
//      "bg1":       "#131215",       // → --bg1   (window backdrop, light end)
//      "glass":     "rgba(24,22,20,.60)",   // → --glass      (panels)
//      "glass2":    "rgba(34,31,28,.65)",   // → --glass-2    (raised panels)
//      "glassHi":   "rgba(255,255,255,.07)",// → --glass-hi   (top highlight)
//      "glassLine": "rgba(216,180,106,.10)",// → --glass-line (hairline borders)
//      "hover":     "rgba(255,255,255,.06)",// → --hover
//      "active":    "rgba(216,180,106,.14)",// → --active
//      "text1":     "#f4efe6",       // → --t1  (primary text)
//      "text2":     "#b6ac98",       // → --t2  (secondary)
//      "text3":     "#6f685a",       // → --t3  (tertiary)
//      "glassBlur": "30px",          // → --glass-blur
//      "glassSat":  "160%",          // → --glass-sat
//      "radius":    "13px",          // → --r-md
//      "radiusLg":  "18px",          // → --r-lg
//      "font":      "'Segoe UI', system-ui, sans-serif"   // → --font
//    }
//  }
//
//  The renderer maps `design` onto its CSS variables, so a theme can restyle the
//  whole chrome from one file. Built-in themes below ship with every install and
//  cannot be removed; user themes are installed from a .pacetheme file.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

let FILE = null;                 // <userData>/pace-themes.json  ({ active, user:{id:doc} })
let state = { active: null, user: {} };

const DESIGN_KEYS = ['accent', 'accent2', 'bg0', 'bg1', 'glass', 'glass2', 'glassHi',
  'glassLine', 'hover', 'active', 'text1', 'text2', 'text3', 'glassBlur', 'glassSat',
  'radius', 'radiusLg', 'font'];

// Animated backdrop styles a theme may pick (replaces the default floating colored orbs).
// "background": { "style": "triangles", "colors": ["#22d3ee", "#e879f9"] }   ← optional in .pacetheme
const BG_STYLES = ['orbs', 'triangles', 'grid', 'aurora', 'waves', 'none'];

// ── Built-in themes (always present) ─────────────────────────────────────────
const BUILTINS = [
  {
    pacetheme: 1, id: 'pace-default', name: 'Pace Default', version: '1.0.0', author: 'Pace',
    description: 'The signature Pace look — indigo and violet on deep glass.', mode: 'dark',
    design: {
      accent: '#5b8ef0', accent2: '#a78bfa', bg0: '#0a0a12', bg1: '#10101c',
      glass: 'rgba(28,29,46,.55)', glass2: 'rgba(38,40,62,.62)', glassHi: 'rgba(255,255,255,.10)',
      glassLine: 'rgba(255,255,255,.08)', hover: 'rgba(255,255,255,.07)', active: 'rgba(255,255,255,.12)',
      text1: '#f1f1fb', text2: '#9d9dc8', text3: '#5c5c7e', glassBlur: '26px', glassSat: '175%',
      radius: '13px', radiusLg: '18px'
    }
  },
  {
    pacetheme: 1, id: 'obsidian-gold', name: 'Obsidian Gold', version: '1.0.0', author: 'Pace',
    description: 'Black glass with warm, restrained gold.', mode: 'dark',
    design: {
      accent: '#d8b46a', accent2: '#f0d488', bg0: '#09090b', bg1: '#131214',
      glass: 'rgba(24,22,20,.60)', glass2: 'rgba(34,31,27,.66)', glassHi: 'rgba(255,255,255,.06)',
      glassLine: 'rgba(216,180,106,.12)', hover: 'rgba(255,255,255,.05)', active: 'rgba(216,180,106,.14)',
      text1: '#f4efe4', text2: '#b6ac96', text3: '#6f6857', glassBlur: '30px', glassSat: '160%',
      radius: '14px', radiusLg: '18px'
    }
  },
  {
    pacetheme: 1, id: 'rose-noir', name: 'Rosé Noir', version: '1.0.0', author: 'Pace',
    description: 'Near-black with a soft rose bloom.', mode: 'dark',
    design: {
      accent: '#e88aa6', accent2: '#f4b8c8', bg0: '#0c0a0d', bg1: '#161116',
      glass: 'rgba(30,22,28,.60)', glass2: 'rgba(42,30,39,.66)', glassHi: 'rgba(255,255,255,.07)',
      glassLine: 'rgba(232,138,166,.13)', hover: 'rgba(255,255,255,.06)', active: 'rgba(232,138,166,.15)',
      text1: '#f6eef2', text2: '#c2a8b5', text3: '#786470', glassBlur: '28px', glassSat: '170%',
      radius: '15px', radiusLg: '20px'
    }
  },
  {
    pacetheme: 1, id: 'emerald', name: 'Emerald', version: '1.0.0', author: 'Pace',
    description: 'Deep forest glass with a cool emerald accent.', mode: 'dark',
    design: {
      accent: '#4fd1a0', accent2: '#8ef0c8', bg0: '#07100c', bg1: '#0e1a14',
      glass: 'rgba(16,30,24,.58)', glass2: 'rgba(22,40,31,.64)', glassHi: 'rgba(255,255,255,.07)',
      glassLine: 'rgba(79,209,160,.13)', hover: 'rgba(255,255,255,.06)', active: 'rgba(79,209,160,.15)',
      text1: '#eaf5ef', text2: '#9bc2af', text3: '#5c7067', glassBlur: '26px', glassSat: '165%',
      radius: '13px', radiusLg: '18px'
    }
  },
  {
    pacetheme: 1, id: 'midnight-mono', name: 'Midnight Mono', version: '1.0.0', author: 'Pace',
    description: 'Monochrome and minimal — pure graphite glass.', mode: 'dark',
    design: {
      accent: '#c7c9d6', accent2: '#9a9db0', bg0: '#0b0b0d', bg1: '#141417',
      glass: 'rgba(26,26,30,.58)', glass2: 'rgba(36,36,42,.64)', glassHi: 'rgba(255,255,255,.07)',
      glassLine: 'rgba(255,255,255,.09)', hover: 'rgba(255,255,255,.06)', active: 'rgba(255,255,255,.12)',
      text1: '#f2f2f5', text2: '#a6a7b2', text3: '#65666f', glassBlur: '28px', glassSat: '130%',
      radius: '12px', radiusLg: '16px'
    }
  },
  {
    pacetheme: 1, id: 'neon-triangles', name: 'Neon Triangles', version: '1.0.0', author: 'Pace',
    description: 'Electric cyan and magenta wireframe triangles drifting on black glass.', mode: 'dark',
    design: {
      accent: '#22d3ee', accent2: '#e879f9', bg0: '#07070d', bg1: '#0d0d18',
      glass: 'rgba(18,20,34,.58)', glass2: 'rgba(26,28,46,.64)', glassHi: 'rgba(255,255,255,.08)',
      glassLine: 'rgba(34,211,238,.14)', hover: 'rgba(255,255,255,.06)', active: 'rgba(34,211,238,.15)',
      text1: '#eefbff', text2: '#93b8c8', text3: '#57707e', glassBlur: '26px', glassSat: '170%',
      radius: '11px', radiusLg: '15px'
    },
    background: { style: 'triangles', colors: ['#22d3ee', '#e879f9', '#818cf8'] }
  },
  {
    pacetheme: 1, id: 'cyber-grid', name: 'Cyber Grid', version: '1.0.0', author: 'Pace',
    description: 'A glowing retro-future grid stretching to the horizon.', mode: 'dark',
    design: {
      accent: '#8b5cf6', accent2: '#22d3ee', bg0: '#08060f', bg1: '#100c1c',
      glass: 'rgba(24,18,40,.58)', glass2: 'rgba(33,26,54,.64)', glassHi: 'rgba(255,255,255,.08)',
      glassLine: 'rgba(139,92,246,.16)', hover: 'rgba(255,255,255,.06)', active: 'rgba(139,92,246,.16)',
      text1: '#f3efff', text2: '#a89cc8', text3: '#665c80', glassBlur: '27px', glassSat: '170%',
      radius: '12px', radiusLg: '16px'
    },
    background: { style: 'grid', colors: ['#8b5cf6', '#22d3ee'] }
  },
  {
    pacetheme: 1, id: 'aurora-veil', name: 'Aurora Veil', version: '1.0.0', author: 'Pace',
    description: 'Slow ribbons of green and violet light, like a night sky.', mode: 'dark',
    design: {
      accent: '#34d399', accent2: '#a78bfa', bg0: '#050a0a', bg1: '#0a1214',
      glass: 'rgba(16,28,28,.58)', glass2: 'rgba(22,38,38,.64)', glassHi: 'rgba(255,255,255,.07)',
      glassLine: 'rgba(52,211,153,.13)', hover: 'rgba(255,255,255,.06)', active: 'rgba(52,211,153,.14)',
      text1: '#ecfbf4', text2: '#98c2b1', text3: '#5c7a6d', glassBlur: '28px', glassSat: '165%',
      radius: '14px', radiusLg: '19px'
    },
    background: { style: 'aurora', colors: ['#34d399', '#a78bfa', '#38bdf8'] }
  }
];

function clean(doc) {
  // Return a safe, normalized theme object or null if invalid.
  if (!doc || typeof doc !== 'object') return null;
  if (Number(doc.pacetheme) !== 1) return null;
  const id = String(doc.id || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 60);
  const name = String(doc.name || '').trim().slice(0, 80);
  if (!id || !name) return null;
  const mode = doc.mode === 'light' ? 'light' : 'dark';
  const din = (doc.design && typeof doc.design === 'object') ? doc.design : {};
  const design = {};
  for (const k of DESIGN_KEYS) {
    if (typeof din[k] === 'string' && din[k].length && din[k].length < 200) design[k] = din[k];
  }
  // Optional animated backdrop: {"style":"orbs|triangles|grid|aurora|waves|none","colors":["#..",...]}
  let background;
  if (doc.background && typeof doc.background === 'object') {
    const st = String(doc.background.style || '').toLowerCase();
    if (BG_STYLES.includes(st)) {
      background = { style: st };
      if (Array.isArray(doc.background.colors)) {
        const cols = doc.background.colors.filter(c => typeof c === 'string' && c.length < 40).slice(0, 4);
        if (cols.length) background.colors = cols;
      }
    }
  }
  return {
    pacetheme: 1, id, name,
    version: String(doc.version || '1.0.0').slice(0, 24),
    author: String(doc.author || '').slice(0, 80),
    description: String(doc.description || '').slice(0, 300),
    mode, design, background, builtin: false
  };
}

function load() {
  try { if (FILE && fs.existsSync(FILE)) state = JSON.parse(fs.readFileSync(FILE, 'utf8')) || state; } catch (e) {}
  if (!state || typeof state !== 'object') state = { active: null, user: {} };
  if (!state.user || typeof state.user !== 'object') state.user = {};
}
function save() { try { if (FILE) fs.writeFileSync(FILE, JSON.stringify(state, null, 2)); } catch (e) {} }

function init(userDataPath) {
  FILE = path.join(userDataPath, 'pace-themes.json');
  load();
}

function all() {
  const builtins = BUILTINS.map(b => ({ ...b, builtin: true }));
  const users = Object.values(state.user || {});
  return [...builtins, ...users];
}

function byId(id) { return all().find(t => t.id === id) || null; }

// Tokens + mode for the currently active theme (or the default if none chosen).
function active() {
  const t = (state.active && byId(state.active)) || byId('pace-default');
  return t ? { id: t.id, mode: t.mode, design: t.design } : null;
}

function list() {
  const act = state.active || 'pace-default';
  return all().map(t => ({
    id: t.id, name: t.name, version: t.version, author: t.author,
    description: t.description, mode: t.mode, design: t.design,
    builtin: !!t.builtin, active: t.id === act
  }));
}

function apply(id) {
  if (!byId(id)) return { ok: false, error: 'Theme not found.' };
  state.active = id; save();
  return { ok: true, active: active() };
}

function reset() { state.active = 'pace-default'; save(); return { ok: true, active: active() }; }

function install(doc) {
  const t = clean(doc);
  if (!t) return { ok: false, error: 'Not a valid .pacetheme file.' };
  // If the id collides with a built-in theme, give the imported theme a fresh unique id rather than
  // rejecting it — a user installing a theme file shouldn't hit a "reserved id" wall.
  if (BUILTINS.some(b => b.id === t.id)) {
    const base = String(t.id || 'theme').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'theme';
    let nid = base + '-' + Math.random().toString(36).slice(2, 7);
    while (BUILTINS.some(b => b.id === nid) || state.user[nid]) nid = base + '-' + Math.random().toString(36).slice(2, 7);
    t.id = nid;
  }
  state.user[t.id] = t; save();
  return { ok: true, id: t.id, name: t.name };
}

function remove(id) {
  if (BUILTINS.some(b => b.id === id)) return { ok: false, error: 'Built-in themes cannot be removed.' };
  if (state.user[id]) delete state.user[id];
  if (state.active === id) state.active = 'pace-default';
  save();
  return { ok: true, active: active() };
}

// Export the built-ins as standalone .pacetheme JSON (used to seed the /themes folder).
function builtinDocs() { return BUILTINS.map(b => { const c = { ...b }; return c; }); }

module.exports = { init, list, active, apply, reset, install, remove, byId, builtinDocs };
