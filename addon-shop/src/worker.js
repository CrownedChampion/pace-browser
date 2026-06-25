// ─────────────────────────────────────────────────────────────────────────────
//  Pace Shop — Cloudflare Worker
//  A single-page storefront (Extensions · Themes · Developer Hub) plus a JSON API,
//  backed entirely by Backblaze B2. Developers sign in to a real account before
//  publishing extensions (.paceaddon) or themes (.pacetheme).
//
//  B2 layout (binding via env: B2_KEY_ID / B2_APP_KEY / B2_BUCKET_ID / B2_BUCKET_NAME):
//    index.json                          → extensions catalogue
//    addons/<id>/addon.json              → extension metadata (public)
//    addons/<id>/<id>.paceaddon          → extension package
//    addons/<id>/publisher.json          → private publisher record (email, ip)
//    themes-index.json                   → themes catalogue
//    themes/<id>/theme.json              → theme metadata (public, incl. preview colours)
//    themes/<id>/<id>.pacetheme          → theme file
//    themes/<id>/publisher.json          → private publisher record
//    users/<email>.json                  → account (PBKDF2 salt+hash, name, handle)
//    users/<email>.published.json        → list of {id, kind} the dev has published
//
//  Sessions are HMAC-signed tokens (env.SESSION_SECRET). Set the secret with:
//    npx wrangler secret put SESSION_SECRET
//
//  Deploy: cd addon-shop && npx wrangler deploy
// ─────────────────────────────────────────────────────────────────────────────

const ACCENT = '#5b8ef0';
const ACCENT2 = '#a78bfa';
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();
    try {
      // App routes → serve the SPA shell; the client routes to the right view.
      if (method === 'GET' && (path === '/' || path === '/extensions' || path === '/themes' || path === '/developers' || path === '/publish')) {
        return htmlResponse(appShell());
      }

      // Catalogues
      if (path === '/api/addons' && method === 'GET') return cors(jsonResponse(await readIndex(env)));
      if (path === '/api/themes' && method === 'GET') return cors(jsonResponse(await readThemesIndex(env)));
      if (path.startsWith('/api/addon/') && method === 'GET') {
        const meta = await readAddonMeta(env, decodeURIComponent(path.slice('/api/addon/'.length)));
        return cors(meta ? jsonResponse(meta) : jsonResponse({ ok: false, error: 'Not found' }, 404));
      }
      if (path.startsWith('/api/theme/') && method === 'GET') {
        const meta = await readThemeMeta(env, decodeURIComponent(path.slice('/api/theme/'.length)));
        return cors(meta ? jsonResponse(meta) : jsonResponse({ ok: false, error: 'Not found' }, 404));
      }

      // Downloads
      if (path.startsWith('/download/') && method === 'GET') return await handleDownload(env, decodeURIComponent(path.slice('/download/'.length)));
      if (path.startsWith('/download-theme/') && method === 'GET') return await handleThemeDownload(env, decodeURIComponent(path.slice('/download-theme/'.length)));

      // Accounts
      if (path === '/api/register' && method === 'POST') return await handleRegister(request, env);
      if (path === '/api/login' && method === 'POST') return await handleLogin(request, env);
      if (path === '/api/me' && method === 'GET') return await handleMe(request, env);
      if (path === '/api/my-items' && method === 'GET') return await handleMyItems(request, env);
      if (path === '/api/publish' && method === 'POST') return await handlePublish(request, env);
      if (method === 'OPTIONS' && path.startsWith('/api/')) return cors(new Response(null, { status: 204 }));

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return cors(jsonResponse({ ok: false, error: String((err && err.message) || err) }, 500));
    }
  }
};

// ── Backblaze B2 ─────────────────────────────────────────────────────────────
let _b2 = null;
async function b2auth(env) {
  if (_b2 && (Date.now() - _b2.ts) < 23 * 3600 * 1000) return _b2;
  const cred = btoa(env.B2_KEY_ID + ':' + env.B2_APP_KEY);
  const r = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', { headers: { Authorization: 'Basic ' + cred } });
  if (!r.ok) throw new Error('B2 auth ' + r.status);
  const d = await r.json();
  const s = (d.apiInfo && d.apiInfo.storageApi) || {};
  _b2 = { token: d.authorizationToken, apiUrl: s.apiUrl, downloadUrl: s.downloadUrl, ts: Date.now() };
  return _b2;
}
async function b2GetText(env, name) {
  const a = await b2auth(env);
  const r = await fetch(a.downloadUrl + '/file/' + env.B2_BUCKET_NAME + '/' + name, { headers: { Authorization: a.token } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('B2 get ' + r.status);
  return await r.text();
}
async function b2GetStream(env, name) {
  const a = await b2auth(env);
  return await fetch(a.downloadUrl + '/file/' + env.B2_BUCKET_NAME + '/' + name, { headers: { Authorization: a.token } });
}
async function sha1hex(buf) {
  const h = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function b2Upload(env, name, bytes, contentType) {
  const a = await b2auth(env);
  const gu = await fetch(a.apiUrl + '/b2api/v3/b2_get_upload_url', {
    method: 'POST', headers: { Authorization: a.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: env.B2_BUCKET_ID })
  });
  if (!gu.ok) throw new Error('B2 get_upload_url ' + gu.status);
  const g = await gu.json();
  const sha1 = await sha1hex(bytes);
  const up = await fetch(g.uploadUrl, {
    method: 'POST', body: bytes,
    headers: {
      Authorization: g.authorizationToken,
      'X-Bz-File-Name': encodeURIComponent(name),
      'Content-Type': contentType || 'application/octet-stream',
      'X-Bz-Content-Sha1': sha1
    }
  });
  if (!up.ok) throw new Error('B2 upload ' + up.status + ' ' + (await up.text()).slice(0, 200));
  return await up.json();
}

// ── Extensions catalogue ─────────────────────────────────────────────────────
async function readIndex(env) {
  try { const txt = await b2GetText(env, 'index.json'); if (!txt) return []; const arr = JSON.parse(txt); return Array.isArray(arr) ? arr : []; }
  catch (e) { return []; }
}
async function writeIndex(env, arr) {
  await b2Upload(env, 'index.json', enc.encode(JSON.stringify(arr, null, 2)), 'application/json');
}
async function readAddonMeta(env, id) {
  try { const txt = await b2GetText(env, 'addons/' + safeId(id) + '/addon.json'); return txt ? JSON.parse(txt) : null; }
  catch (e) { return null; }
}
async function handleDownload(env, id) {
  const name = 'addons/' + safeId(id) + '/' + safeId(id) + '.paceaddon';
  const r = await b2GetStream(env, name);
  if (!r.ok) return new Response('Package not found', { status: 404 });
  try { const idx = await readIndex(env); const e = idx.find(a => a.id === id); if (e) { e.downloads = (e.downloads || 0) + 1; await writeIndex(env, idx); } } catch (e) {}
  return new Response(r.body, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="' + safeId(id) + '.paceaddon"', 'Cache-Control': 'no-store' } });
}

// ── Themes catalogue ─────────────────────────────────────────────────────────
async function readThemesIndexRaw(env) {
  try { const txt = await b2GetText(env, 'themes-index.json'); if (!txt) return []; const arr = JSON.parse(txt); return Array.isArray(arr) ? arr : []; }
  catch (e) { return []; }
}
async function writeThemesIndex(env, arr) {
  await b2Upload(env, 'themes-index.json', enc.encode(JSON.stringify(arr, null, 2)), 'application/json');
}
async function readThemesIndex(env) {
  const raw = await readThemesIndexRaw(env);
  const map = {};
  for (const f of featuredThemes()) map[f.id] = { id: f.id, name: f.name, version: f.version, description: f.description, author: f.author, handle: f.handle, mode: f.mode, downloads: f.downloads || 0, featured: true, updated: f.updated, preview: f.preview };
  for (const r of raw) map[r.id] = r;
  return Object.values(map).sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || (b.updated || '').localeCompare(a.updated || ''));
}
async function readThemeMeta(env, id) {
  const f = featuredThemes().find(t => t.id === id);
  if (f) return { id: f.id, name: f.name, version: f.version, description: f.description, author: f.author, handle: f.handle, mode: f.mode, downloads: f.downloads || 0, featured: true, preview: f.preview };
  try { const txt = await b2GetText(env, 'themes/' + safeId(id) + '/theme.json'); return txt ? JSON.parse(txt) : null; }
  catch (e) { return null; }
}
async function handleThemeDownload(env, id) {
  const f = featuredThemes().find(t => t.id === id);
  if (f) {
    const doc = { pacetheme: 1, id: f.id, name: f.name, version: f.version, author: f.author, description: f.description, mode: f.mode, design: f.design };
    return new Response(JSON.stringify(doc, null, 2), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + safeId(id) + '.pacetheme"', 'Cache-Control': 'no-store' } });
  }
  const name = 'themes/' + safeId(id) + '/' + safeId(id) + '.pacetheme';
  const r = await b2GetStream(env, name);
  if (!r.ok) return new Response('Theme not found', { status: 404 });
  try { const idx = await readThemesIndexRaw(env); const e = idx.find(a => a.id === id); if (e) { e.downloads = (e.downloads || 0) + 1; await writeThemesIndex(env, idx); } } catch (e) {}
  return new Response(r.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + safeId(id) + '.pacetheme"', 'Cache-Control': 'no-store' } });
}

// A handful of beautiful built-in themes so the Themes page is alive from day one.
function featuredThemes() {
  const base = { bg0: '#0a0a12', bg1: '#10101c', glass: 'rgba(255,255,255,0.06)', glass2: 'rgba(255,255,255,0.04)', glassLine: 'rgba(255,255,255,0.09)', hover: 'rgba(255,255,255,0.06)', active: 'rgba(255,255,255,0.10)', text1: '#f4f5f7', text2: '#aab0bd', text3: '#6c7280', radius: '12px', font: '-apple-system, Inter, Segoe UI, sans-serif' };
  const mk = (id, name, accent, accent2, over) => ({ id, name, version: '1.0.0', author: 'Pace', handle: 'pace', mode: 'dark', downloads: 0, updated: '2026-01-01T00:00:00.000Z', description: over && over.desc || 'A built-in Pace theme.', design: Object.assign({}, base, { accent, accent2 }, over && over.design || {}), get preview() { const d = this.design; return { bg0: d.bg0, bg1: d.bg1, glass: d.glass, glass2: d.glass2, accent: d.accent, accent2: d.accent2, text1: d.text1, text2: d.text2, active: d.active, mode: 'dark' }; } });
  return [
    mk('pace-default', 'Pace Default', '#5b8ef0', '#a78bfa', { desc: 'The signature Pace look — cool blues over deep space.' }),
    mk('obsidian-gold', 'Obsidian Gold', '#d4af37', '#f0d77a', { desc: 'Black obsidian with warm gold accents.', design: { bg0: '#08080a', bg1: '#0f0f12' } }),
    mk('rose-noir', 'Rose Noir', '#e8628a', '#ff9db8', { desc: 'Moody noir with a rose-pink glow.', design: { bg0: '#0c0810', bg1: '#140d18' } }),
    mk('emerald', 'Emerald', '#34d399', '#6ee7b7', { desc: 'Deep forest green with bright emerald highlights.', design: { bg0: '#07120d', bg1: '#0c1a13' } }),
    mk('midnight-mono', 'Midnight Mono', '#8b93a7', '#aeb6c7', { desc: 'A calm, monochrome midnight palette.', design: { bg0: '#0a0b0e', bg1: '#101218' } })
  ];
}

// ── Accounts & sessions ──────────────────────────────────────────────────────
function b64url(buf) { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlToBytes(str) { str = String(str).replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const bin = atob(str); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function sessionSecret(env) { return (env && env.SESSION_SECRET) || 'pace-INSECURE-default-set-SESSION_SECRET'; }
async function hmacKey(env) { return crypto.subtle.importKey('raw', enc.encode(sessionSecret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function signSession(env, claims) { const payload = b64url(enc.encode(JSON.stringify(claims))); const key = await hmacKey(env); const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload)); return payload + '.' + b64url(sig); }
async function verifySession(env, token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  let ok = false;
  try { const key = await hmacKey(env); ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), enc.encode(payload)); } catch (e) { return null; }
  if (!ok) return null;
  let claims; try { claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))); } catch (e) { return null; }
  if (!claims || (claims.exp && Date.now() > claims.exp)) return null;
  return claims;
}
async function getSessionUser(request, env) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return await verifySession(env, m[1].trim());
}
async function hashPw(password, saltBytes) {
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
function randomSaltB64() { return b64url(crypto.getRandomValues(new Uint8Array(16))); }
function emailKey(email) { return String(email).trim().toLowerCase().replace(/[^a-z0-9@._+-]/g, ''); }
function userKey(email) { return 'users/' + emailKey(email) + '.json'; }
function userPubKey(email) { return 'users/' + emailKey(email) + '.published.json'; }

async function handleRegister(request, env) {
  let b; try { b = await request.json(); } catch (e) { return cors(jsonResponse({ ok: false, error: 'Bad request.' }, 400)); }
  const email = String(b.email || '').trim().toLowerCase();
  const name = String(b.name || '').trim().slice(0, 80);
  const handle = String(b.handle || '').trim().replace(/^@+/, '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40);
  const password = String(b.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return cors(jsonResponse({ ok: false, error: 'Enter a valid email address.' }, 400));
  if (!name) return cors(jsonResponse({ ok: false, error: 'Enter your developer name.' }, 400));
  if (password.length < 8) return cors(jsonResponse({ ok: false, error: 'Password must be at least 8 characters.' }, 400));
  let existing = null; try { existing = await b2GetText(env, userKey(email)); } catch (e) {}
  if (existing) return cors(jsonResponse({ ok: false, error: 'An account with that email already exists.' }, 409));
  const salt = randomSaltB64();
  const hash = await hashPw(password, b64urlToBytes(salt));
  const user = { email, name, handle, salt, hash, created: new Date().toISOString() };
  await b2Upload(env, userKey(email), enc.encode(JSON.stringify(user, null, 2)), 'application/json');
  const token = await signSession(env, { email, name, handle, exp: Date.now() + SESSION_TTL });
  return cors(jsonResponse({ ok: true, token, user: { email, name, handle } }));
}
async function handleLogin(request, env) {
  let b; try { b = await request.json(); } catch (e) { return cors(jsonResponse({ ok: false, error: 'Bad request.' }, 400)); }
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  let txt = null; try { txt = await b2GetText(env, userKey(email)); } catch (e) {}
  if (!txt) return cors(jsonResponse({ ok: false, error: 'Incorrect email or password.' }, 401));
  let user; try { user = JSON.parse(txt); } catch (e) { return cors(jsonResponse({ ok: false, error: 'Account data error.' }, 500)); }
  const hash = await hashPw(password, b64urlToBytes(user.salt));
  if (hash !== user.hash) return cors(jsonResponse({ ok: false, error: 'Incorrect email or password.' }, 401));
  const token = await signSession(env, { email: user.email, name: user.name, handle: user.handle, exp: Date.now() + SESSION_TTL });
  return cors(jsonResponse({ ok: true, token, user: { email: user.email, name: user.name, handle: user.handle } }));
}
async function handleMe(request, env) {
  const u = await getSessionUser(request, env);
  if (!u) return cors(jsonResponse({ ok: false }, 401));
  return cors(jsonResponse({ ok: true, user: { email: u.email, name: u.name, handle: u.handle } }));
}
async function handleMyItems(request, env) {
  const u = await getSessionUser(request, env);
  if (!u) return cors(jsonResponse({ ok: false }, 401));
  let ids = []; try { const t = await b2GetText(env, userPubKey(u.email)); if (t) ids = JSON.parse(t); } catch (e) {}
  if (!Array.isArray(ids)) ids = [];
  const exts = await readIndex(env); const ths = await readThemesIndexRaw(env);
  const items = [];
  for (const rec of ids) {
    if (rec.kind === 'theme') { const m = ths.find(x => x.id === rec.id); if (m) items.push(Object.assign({}, m, { kind: 'theme' })); }
    else { const m = exts.find(x => x.id === rec.id); if (m) items.push(Object.assign({}, m, { kind: 'extension' })); }
  }
  return cors(jsonResponse({ ok: true, items }));
}
async function addToPublished(env, email, id, kind) {
  let ids = []; try { const t = await b2GetText(env, userPubKey(email)); if (t) ids = JSON.parse(t); } catch (e) {}
  if (!Array.isArray(ids)) ids = [];
  if (!ids.find(r => r.id === id && r.kind === kind)) ids.push({ id, kind });
  await b2Upload(env, userPubKey(email), enc.encode(JSON.stringify(ids, null, 2)), 'application/json');
}

// ── Publishing (session-gated; extension OR theme) ───────────────────────────
async function handlePublish(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return cors(jsonResponse({ ok: false, error: 'Please sign in to publish.' }, 401));
  const form = await request.formData();
  if (form.get('agree') !== 'on' && form.get('agree') !== 'true') return cors(jsonResponse({ ok: false, error: 'You must accept the developer agreement.' }, 400));
  const kind = String(form.get('kind') || 'extension');
  return kind === 'theme' ? await publishTheme(form, user, env, request) : await publishExtension(form, user, env, request);
}
async function publishExtension(form, user, env, request) {
  const id = safeId(String(form.get('id') || ''));
  const name = String(form.get('name') || '').trim();
  const version = String(form.get('version') || '1.0.0').trim();
  const description = String(form.get('description') || '').trim();
  const file = form.get('file');
  if (!id) return cors(jsonResponse({ ok: false, error: 'A valid id is required (letters, numbers, - _ .).' }, 400));
  if (!name) return cors(jsonResponse({ ok: false, error: 'A name is required.' }, 400));
  if (!file || typeof file.arrayBuffer !== 'function') return cors(jsonResponse({ ok: false, error: 'A .paceaddon package is required.' }, 400));
  if (!/\.paceaddon$/i.test(String(file.name || ''))) return cors(jsonResponse({ ok: false, error: 'Extensions must be a .paceaddon file.' }, 400));
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) return cors(jsonResponse({ ok: false, error: 'The package file is empty.' }, 400));
  if (bytes.byteLength > 5 * 1024 * 1024) return cors(jsonResponse({ ok: false, error: 'Package too large (max 5 MB).' }, 400));
  const now = new Date().toISOString();
  const meta = { id, name, version, description, author: user.name, handle: user.handle, updated: now, size: bytes.byteLength };
  const publisher = { id, kind: 'extension', author: user.name, email: user.email, handle: user.handle, version, publishedAt: now, ip: request.headers.get('CF-Connecting-IP') || '' };
  await b2Upload(env, 'addons/' + id + '/' + id + '.paceaddon', bytes, 'application/zip');
  await b2Upload(env, 'addons/' + id + '/addon.json', enc.encode(JSON.stringify(meta, null, 2)), 'application/json');
  await b2Upload(env, 'addons/' + id + '/publisher.json', enc.encode(JSON.stringify(publisher, null, 2)), 'application/json');
  const idx = await readIndex(env);
  const downloads = (idx.find(a => a.id === id) || {}).downloads || 0;
  const summary = { id, name, version, description, author: user.name, handle: user.handle, updated: now, downloads };
  const pos = idx.findIndex(a => a.id === id); if (pos >= 0) idx[pos] = summary; else idx.push(summary);
  idx.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  await writeIndex(env, idx);
  await addToPublished(env, user.email, id, 'extension');
  return cors(jsonResponse({ ok: true, id, name, version, kind: 'extension' }));
}
async function publishTheme(form, user, env, request) {
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') return cors(jsonResponse({ ok: false, error: 'A .pacetheme file is required.' }, 400));
  if (!/\.pacetheme$/i.test(String(file.name || ''))) return cors(jsonResponse({ ok: false, error: 'Themes must be a .pacetheme file.' }, 400));
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) return cors(jsonResponse({ ok: false, error: 'The theme file is empty.' }, 400));
  if (bytes.byteLength > 512 * 1024) return cors(jsonResponse({ ok: false, error: 'Theme file too large (max 512 KB).' }, 400));
  let doc; try { doc = JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { return cors(jsonResponse({ ok: false, error: 'The .pacetheme file is not valid JSON.' }, 400)); }
  if (!doc || doc.pacetheme !== 1 || !doc.design || typeof doc.design !== 'object') return cors(jsonResponse({ ok: false, error: 'Not a valid Pace theme (expected pacetheme:1 with a design block).' }, 400));
  const id = safeId(String(form.get('id') || doc.id || ''));
  const name = String(form.get('name') || doc.name || '').trim();
  const version = String(form.get('version') || doc.version || '1.0.0').trim();
  const description = String(form.get('description') || doc.description || '').trim();
  if (!id) return cors(jsonResponse({ ok: false, error: 'A valid theme id is required.' }, 400));
  if (!name) return cors(jsonResponse({ ok: false, error: 'A theme name is required.' }, 400));
  if (featuredThemes().find(t => t.id === id)) return cors(jsonResponse({ ok: false, error: 'That id is reserved by a built-in theme — choose another.' }, 409));
  const d = doc.design || {};
  const preview = { bg0: d.bg0 || '#0a0a12', bg1: d.bg1 || '#10101c', glass: d.glass || 'rgba(255,255,255,0.06)', glass2: d.glass2 || 'rgba(255,255,255,0.04)', accent: d.accent || '#5b8ef0', accent2: d.accent2 || d.accent || '#a78bfa', text1: d.text1 || '#f4f5f7', text2: d.text2 || '#aab0bd', active: d.active || 'rgba(255,255,255,0.10)', mode: doc.mode || 'dark' };
  const now = new Date().toISOString();
  const meta = { id, name, version, description, author: user.name, handle: user.handle, mode: doc.mode || 'dark', updated: now, size: bytes.byteLength, preview };
  const publisher = { id, kind: 'theme', author: user.name, email: user.email, handle: user.handle, version, publishedAt: now, ip: request.headers.get('CF-Connecting-IP') || '' };
  await b2Upload(env, 'themes/' + id + '/' + id + '.pacetheme', bytes, 'application/json');
  await b2Upload(env, 'themes/' + id + '/theme.json', enc.encode(JSON.stringify(meta, null, 2)), 'application/json');
  await b2Upload(env, 'themes/' + id + '/publisher.json', enc.encode(JSON.stringify(publisher, null, 2)), 'application/json');
  const idx = await readThemesIndexRaw(env);
  const downloads = (idx.find(a => a.id === id) || {}).downloads || 0;
  const summary = { id, name, version, description, author: user.name, handle: user.handle, mode: doc.mode || 'dark', updated: now, downloads, preview };
  const pos = idx.findIndex(a => a.id === id); if (pos >= 0) idx[pos] = summary; else idx.push(summary);
  idx.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  await writeThemesIndex(env, idx);
  await addToPublished(env, user.email, id, 'theme');
  return cors(jsonResponse({ ok: true, id, name, version, kind: 'theme' }));
}

// ── utilities ─────────────────────────────────────────────────────────────────
function safeId(s) { return String(s).replace(/[^a-z0-9_.-]/gi, '').slice(0, 80); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function htmlResponse(body) { return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
function jsonResponse(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }
function cors(resp) {
  resp.headers.set('Access-Control-Allow-Origin', '*');
  resp.headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  resp.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return resp;
}

// ── The single-page app ─────────────────────────────────────────────────────
// NOTE: the client script below intentionally avoids template literals and ${}
// so it can live safely inside this outer template literal.
function appShell() {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Pace Shop</title>
<style>
  :root{
    --acc:${ACCENT}; --acc2:${ACCENT2};
    --bg:#070709; --panel:rgba(255,255,255,.045); --panel2:rgba(255,255,255,.028);
    --line:rgba(255,255,255,.08); --line2:rgba(255,255,255,.05);
    --t1:#f3f4f7; --t2:#a6acba; --t3:#5f6573;
    --ease:cubic-bezier(.16,1,.3,1); --r:22px;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;
    background:var(--bg); color:var(--t1); -webkit-font-smoothing:antialiased;
    overflow-x:hidden; letter-spacing:-.01em; line-height:1.5;
  }
  /* drifting ambient glows */
  .bg-fx{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
  .blob{position:absolute;border-radius:50%;filter:blur(90px);opacity:.5;will-change:transform}
  .blob.b1{width:560px;height:560px;background:radial-gradient(circle,rgba(91,142,240,.5),transparent 70%);top:-160px;left:-120px;animation:drift1 22s var(--ease) infinite alternate}
  .blob.b2{width:520px;height:520px;background:radial-gradient(circle,rgba(167,139,250,.42),transparent 70%);top:8%;right:-140px;animation:drift2 26s var(--ease) infinite alternate}
  .blob.b3{width:480px;height:480px;background:radial-gradient(circle,rgba(52,211,153,.18),transparent 70%);bottom:-180px;left:30%;animation:drift3 30s var(--ease) infinite alternate}
  @keyframes drift1{to{transform:translate(120px,80px) scale(1.15)}}
  @keyframes drift2{to{transform:translate(-100px,120px) scale(1.1)}}
  @keyframes drift3{to{transform:translate(80px,-90px) scale(1.2)}}
  .wrap{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:0 24px}

  /* nav */
  header{position:sticky;top:0;z-index:50;backdrop-filter:blur(26px) saturate(180%);-webkit-backdrop-filter:blur(26px) saturate(180%);background:rgba(8,8,11,.62);border-bottom:1px solid var(--line2)}
  .nav{display:flex;align-items:center;gap:18px;height:66px;max-width:1180px;margin:0 auto;padding:0 24px}
  .brand{display:flex;align-items:center;gap:11px;font-weight:680;font-size:16.5px;letter-spacing:-.02em;cursor:pointer;user-select:none}
  .logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--acc),var(--acc2));display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:16px;box-shadow:0 4px 18px rgba(91,142,240,.45)}
  .brand .sub{color:var(--t3);font-weight:520}
  .seg{position:relative;display:flex;gap:2px;margin-left:8px;padding:4px;border-radius:99px;background:var(--panel2);border:1px solid var(--line2)}
  .seg a{position:relative;z-index:2;padding:8px 17px;border-radius:99px;font-size:13.5px;font-weight:560;color:var(--t2);text-decoration:none;transition:color .25s var(--ease);white-space:nowrap}
  .seg a.on{color:#fff}
  .seg .pill{position:absolute;z-index:1;top:4px;left:4px;height:calc(100% - 8px);border-radius:99px;background:linear-gradient(135deg,rgba(91,142,240,.95),rgba(167,139,250,.92));box-shadow:0 6px 20px rgba(91,142,240,.4);transition:transform .42s var(--ease),width .42s var(--ease);width:0}
  .nav-r{margin-left:auto;display:flex;align-items:center;gap:12px}
  .who{font-size:13px;color:var(--t2)}
  .who b{color:var(--t1);font-weight:600}
  .btn{font-family:inherit;font-size:13.5px;font-weight:600;border:none;border-radius:99px;padding:9px 18px;cursor:pointer;transition:transform .2s var(--ease),box-shadow .25s var(--ease),background .2s,filter .2s;white-space:nowrap}
  .btn:active{transform:scale(.96)}
  .btn-p{background:linear-gradient(135deg,var(--acc),var(--acc2));color:#fff;box-shadow:0 6px 22px rgba(91,142,240,.42)}
  .btn-p:hover{filter:brightness(1.08);box-shadow:0 9px 30px rgba(91,142,240,.55)}
  .btn-g{background:var(--panel);color:var(--t1);border:1px solid var(--line)}
  .btn-g:hover{background:rgba(255,255,255,.09)}
  .btn-sm{padding:7px 14px;font-size:12.5px}

  /* views */
  main{position:relative;z-index:1;padding:0 0 100px}
  .view{display:none}
  .view.on{display:block}
  .view.anim{animation:viewIn .5s var(--ease)}
  @keyframes viewIn{from{opacity:0;transform:translateY(16px) scale(.992)}to{opacity:1;transform:none}}

  /* hero */
  .hero{padding:64px 0 30px;text-align:center}
  .eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--t2);background:var(--panel2);border:1px solid var(--line2);padding:6px 14px;border-radius:99px;margin-bottom:22px}
  .eyebrow .dot{width:6px;height:6px;border-radius:50%;background:var(--acc);box-shadow:0 0 10px var(--acc)}
  h1{font-size:clamp(36px,6vw,62px);font-weight:720;letter-spacing:-.035em;line-height:1.02;background:linear-gradient(180deg,#fff,#b9bfce);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .hero p{max-width:560px;margin:18px auto 0;color:var(--t2);font-size:16.5px}
  .search{max-width:520px;margin:30px auto 0;position:relative}
  .search input{width:100%;font-family:inherit;font-size:15px;color:var(--t1);background:var(--panel);border:1px solid var(--line);border-radius:99px;padding:15px 18px 15px 48px;outline:none;transition:border-color .25s,box-shadow .25s,background .25s}
  .search input::placeholder{color:var(--t3)}
  .search input:focus{border-color:rgba(91,142,240,.6);box-shadow:0 0 0 4px rgba(91,142,240,.14);background:rgba(255,255,255,.06)}
  .search svg{position:absolute;left:18px;top:50%;transform:translateY(-50%);color:var(--t3)}

  .sec-head{display:flex;align-items:baseline;justify-content:space-between;margin:40px 0 18px}
  .sec-head h2{font-size:21px;font-weight:660;letter-spacing:-.02em}
  .sec-head .count{font-size:13px;color:var(--t3)}

  /* grid + cards */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:18px}
  .card{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:22px;cursor:pointer;overflow:hidden;transition:transform .42s var(--ease),box-shadow .42s var(--ease),border-color .42s var(--ease);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);animation:cardIn .5s var(--ease) both}
  @keyframes cardIn{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
  .card::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;background:linear-gradient(135deg,rgba(255,255,255,.14),transparent 40%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:0;transition:opacity .42s var(--ease)}
  .card:hover{transform:translateY(-6px);box-shadow:0 26px 60px rgba(0,0,0,.55);border-color:rgba(91,142,240,.45)}
  .card:hover::before{opacity:1}
  .ext-top{display:flex;align-items:center;gap:14px;margin-bottom:14px}
  .ic{width:50px;height:50px;border-radius:14px;flex:none;display:flex;align-items:center;justify-content:center;font-weight:740;font-size:21px;color:#fff;letter-spacing:-.02em;box-shadow:0 6px 18px rgba(0,0,0,.35)}
  .nm{font-size:16px;font-weight:640;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .by{font-size:12.5px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ds{font-size:13.5px;color:var(--t2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:40px}
  .card-foot{display:flex;align-items:center;justify-content:space-between;margin-top:16px;gap:10px}
  .meta-s{font-size:12px;color:var(--t3);display:flex;align-items:center;gap:6px}
  .pillv{font-size:11px;font-weight:600;color:var(--t2);background:var(--panel2);border:1px solid var(--line2);padding:3px 9px;border-radius:99px}

  /* theme preview mini chrome */
  .tprev{border-radius:14px;overflow:hidden;border:1px solid var(--line2);margin-bottom:15px;aspect-ratio:16/9;display:flex;flex-direction:column;box-shadow:0 8px 22px rgba(0,0,0,.4)}
  .tprev-bar{display:flex;align-items:center;gap:6px;padding:8px 9px}
  .tprev-dots{display:flex;gap:4px;margin-right:4px}
  .tprev-dots i{width:7px;height:7px;border-radius:50%;display:block;opacity:.8}
  .tprev-tab{font-size:9px;font-weight:600;padding:4px 10px;border-radius:7px;white-space:nowrap;max-width:74px;overflow:hidden;text-overflow:ellipsis}
  .tprev-addr{flex:1;height:16px;border-radius:7px;display:flex;align-items:center;padding:0 8px;font-size:8px}
  .tprev-body{flex:1;padding:11px;display:flex;flex-direction:column;gap:7px}
  .tprev-line{height:7px;border-radius:5px;opacity:.9}
  .tprev-chips{display:flex;gap:6px;margin-top:auto}
  .tprev-chips i{height:18px;border-radius:6px;flex:1;display:block}

  .empty,.loading-note{padding:60px 24px;text-align:center;color:var(--t3);font-size:14.5px;grid-column:1/-1}
  .sk{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);height:188px;position:relative;overflow:hidden}
  .sk::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 20%,rgba(255,255,255,.06) 50%,transparent 80%);animation:shim 1.4s infinite}
  @keyframes shim{from{transform:translateX(-100%)}to{transform:translateX(100%)}}

  /* developer hub */
  .dev-wrap{max-width:920px;margin:0 auto}
  .auth-card{max-width:430px;margin:30px auto 0;background:var(--panel);border:1px solid var(--line);border-radius:24px;padding:34px;backdrop-filter:blur(26px);-webkit-backdrop-filter:blur(26px);box-shadow:0 30px 70px rgba(0,0,0,.5)}
  .auth-seg{display:flex;background:var(--panel2);border:1px solid var(--line2);border-radius:99px;padding:4px;margin-bottom:26px;position:relative}
  .auth-seg button{flex:1;background:none;border:none;color:var(--t2);font-family:inherit;font-size:13.5px;font-weight:600;padding:9px;border-radius:99px;cursor:pointer;position:relative;z-index:2;transition:color .25s}
  .auth-seg button.on{color:#fff}
  .auth-seg .ind{position:absolute;z-index:1;top:4px;height:calc(100% - 8px);width:calc(50% - 4px);left:4px;border-radius:99px;background:linear-gradient(135deg,var(--acc),var(--acc2));transition:transform .38s var(--ease);box-shadow:0 5px 16px rgba(91,142,240,.4)}
  .auth-seg.r .ind{transform:translateX(100%)}
  .field{margin-bottom:14px}
  .field label{display:block;font-size:12px;font-weight:600;color:var(--t2);margin:0 0 7px 2px}
  .field input,.field textarea{width:100%;font-family:inherit;font-size:14px;color:var(--t1);background:var(--panel2);border:1px solid var(--line);border-radius:13px;padding:12px 14px;outline:none;transition:border-color .2s,box-shadow .2s}
  .field input:focus,.field textarea:focus{border-color:rgba(91,142,240,.6);box-shadow:0 0 0 4px rgba(91,142,240,.13)}
  .field textarea{resize:vertical;min-height:64px}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .form-msg{font-size:13px;margin-top:6px;min-height:18px}
  .form-msg.err{color:#ff7a7a}
  .form-msg.ok{color:#4ade80}
  .muted{color:var(--t3);font-size:12.5px;text-align:center;margin-top:16px;line-height:1.5}

  .dash-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px;margin:28px 0 8px}
  .dash-head h2{font-size:25px;font-weight:680;letter-spacing:-.025em}
  .dash-head p{color:var(--t2);font-size:14px;margin-top:3px}
  .pub-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:22px}
  @media(max-width:760px){.pub-grid{grid-template-columns:1fr}.row2{grid-template-columns:1fr}.seg{display:none}}
  .pub-card{background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:24px;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}
  .pub-card h3{font-size:16px;font-weight:640;margin-bottom:4px;display:flex;align-items:center;gap:9px}
  .pub-card .hint{font-size:12.5px;color:var(--t3);margin-bottom:18px}
  .badge{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:3px 8px;border-radius:6px;background:rgba(91,142,240,.16);color:#9cc0ff}
  .badge.t{background:rgba(167,139,250,.16);color:#c9b8ff}
  .drop{border:1.5px dashed var(--line);border-radius:14px;padding:22px;text-align:center;cursor:pointer;transition:border-color .25s,background .25s;color:var(--t2);font-size:13px;margin-bottom:14px}
  .drop:hover,.drop.over{border-color:var(--acc);background:rgba(91,142,240,.07);color:var(--t1)}
  .drop .fn{color:var(--acc);font-weight:600;margin-top:6px;word-break:break-all}
  .chk{display:flex;align-items:flex-start;gap:9px;font-size:12.5px;color:var(--t2);margin:4px 0 16px;cursor:pointer;line-height:1.45}
  .chk input{margin-top:2px;accent-color:var(--acc);width:15px;height:15px;flex:none}

  /* modal */
  .modal{position:fixed;inset:0;z-index:100;display:none;align-items:center;justify-content:center;padding:24px}
  .modal.on{display:flex;animation:fade .3s var(--ease)}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  .modal-bg{position:absolute;inset:0;background:rgba(4,4,7,.72);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
  .modal-card{position:relative;z-index:2;max-width:500px;width:100%;background:rgba(18,18,24,.92);border:1px solid var(--line);border-radius:24px;padding:30px;box-shadow:0 40px 90px rgba(0,0,0,.6);animation:pop .42s var(--ease)}
  @keyframes pop{from{opacity:0;transform:translateY(22px) scale(.96)}to{opacity:1;transform:none}}
  .modal-close{position:absolute;top:16px;right:16px;width:32px;height:32px;border-radius:50%;border:none;background:var(--panel);color:var(--t2);cursor:pointer;font-size:16px;transition:background .2s,color .2s}
  .modal-close:hover{background:rgba(255,255,255,.1);color:#fff}

  /* toast */
  .toasts{position:fixed;right:22px;bottom:22px;z-index:200;display:flex;flex-direction:column;gap:10px}
  .toast{background:rgba(20,20,26,.95);border:1px solid var(--line);border-radius:14px;padding:13px 17px;font-size:13.5px;color:var(--t1);box-shadow:0 16px 40px rgba(0,0,0,.5);animation:slideIn .4s var(--ease);max-width:320px}
  .toast.ok{border-color:rgba(74,222,128,.4)}
  .toast.err{border-color:rgba(255,122,122,.45)}
  @keyframes slideIn{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:none}}
  .foot{text-align:center;color:var(--t3);font-size:12.5px;padding:30px 0 10px}
  a.link{color:var(--acc);text-decoration:none}a.link:hover{text-decoration:underline}
</style></head>
<body>
<div class="bg-fx"><div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div></div>

<header><nav class="nav">
  <div class="brand" data-go="extensions"><div class="logo">P</div><span>Pace <span class="sub">Shop</span></span></div>
  <div class="seg" id="seg">
    <span class="pill" id="pill"></span>
    <a href="/extensions" data-go="extensions">Extensions</a>
    <a href="/themes" data-go="themes">Themes</a>
    <a href="/developers" data-go="developers">Developers</a>
  </div>
  <div class="nav-r" id="navr"></div>
</nav></header>

<main>
  <section class="view" id="view-extensions">
    <div class="wrap">
      <div class="hero">
        <div class="eyebrow"><span class="dot"></span> Extensions for Pace</div>
        <h1>Extend your browser.</h1>
        <p>Hand-built add-ons that make Pace faster, cleaner, and more yours — installed in one click.</p>
        <div class="search"><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.6"/><path d="M13 13l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><input id="search-ext" placeholder="Search extensions"></div>
      </div>
      <div class="sec-head"><h2>All extensions</h2><span class="count" id="count-ext"></span></div>
      <div class="grid" id="grid-ext"></div>
    </div>
  </section>

  <section class="view" id="view-themes">
    <div class="wrap">
      <div class="hero">
        <div class="eyebrow"><span class="dot" style="background:var(--acc2);box-shadow:0 0 10px var(--acc2)"></span> Themes for Pace</div>
        <h1>Dress it up.</h1>
        <p>Re-skin the entire browser chrome with a single file. Preview the palette, then make it yours.</p>
        <div class="search"><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.6"/><path d="M13 13l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><input id="search-thm" placeholder="Search themes"></div>
      </div>
      <div class="sec-head"><h2>All themes</h2><span class="count" id="count-thm"></span></div>
      <div class="grid" id="grid-thm"></div>
    </div>
  </section>

  <section class="view" id="view-developers">
    <div class="wrap dev-wrap" id="dev-root"></div>
  </section>
</main>

<div class="modal" id="modal"><div class="modal-bg" data-close="1"></div><div class="modal-card" id="modal-card"></div></div>
<div class="toasts" id="toasts"></div>

<script>
(function(){
  "use strict";
  var TOKEN_KEY="pace_dev_token", USER_KEY="pace_dev_user";
  var state={view:"extensions",ext:null,thm:null,extLoad:false,thmLoad:false,user:null,token:null,authMode:"in"};
  function $(id){return document.getElementById(id);}
  function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];});}
  function initials(s){s=(s||"?").trim();var p=s.split(/\\s+/);return ((p[0]||"")[0]||"")+((p[1]||"")[0]||"")||s[0]||"?";}
  function hue(s){var h=0;s=s||"x";for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))%360;return h;}
  function num(n){n=n||0;if(n>=1000)return (n/1000).toFixed(n>=10000?0:1)+"k";return String(n);}

  function toast(msg,kind){
    var t=document.createElement("div");t.className="toast "+(kind||"");t.textContent=msg;
    $("toasts").appendChild(t);
    setTimeout(function(){t.style.transition="opacity .3s,transform .3s";t.style.opacity="0";t.style.transform="translateX(40px)";setTimeout(function(){t.remove();},320);},2600);
  }

  // ── session ──
  function loadSession(){
    try{state.token=localStorage.getItem(TOKEN_KEY)||null;var u=localStorage.getItem(USER_KEY);state.user=u?JSON.parse(u):null;}catch(e){}
  }
  function saveSession(token,user){
    state.token=token;state.user=user;
    try{localStorage.setItem(TOKEN_KEY,token);localStorage.setItem(USER_KEY,JSON.stringify(user));}catch(e){}
    renderNav();
  }
  function clearSession(){
    state.token=null;state.user=null;
    try{localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(USER_KEY);}catch(e){}
    renderNav();
  }
  function api(path,opts){
    opts=opts||{};opts.headers=opts.headers||{};
    if(state.token)opts.headers["Authorization"]="Bearer "+state.token;
    return fetch(path,opts).then(function(r){return r.json().then(function(j){return {status:r.status,body:j};}).catch(function(){return {status:r.status,body:{}};});});
  }

  // ── nav / router ──
  function renderNav(){
    var r=$("navr");
    if(state.user){
      r.innerHTML='<span class="who">Hi, <b>'+esc(state.user.name)+'</b></span><button class="btn btn-g btn-sm" id="nav-hub">Developer hub</button>';
      $("nav-hub").onclick=function(){go("developers");};
    } else {
      r.innerHTML='<button class="btn btn-p btn-sm" id="nav-dev">Become a developer</button>';
      $("nav-dev").onclick=function(){go("developers");};
    }
  }
  function movePill(){
    var seg=$("seg"),pill=$("pill");
    var link=seg.querySelector('a[data-go="'+state.view+'"]');
    if(!link){pill.style.width="0";return;}
    pill.style.width=link.offsetWidth+"px";
    pill.style.transform="translateX("+(link.offsetLeft-4)+"px)";
    [].forEach.call(seg.querySelectorAll("a"),function(a){a.classList.toggle("on",a.getAttribute("data-go")===state.view);});
  }
  function pathFor(v){return v==="extensions"?"/extensions":v==="themes"?"/themes":"/developers";}
  function viewFromPath(p){if(p==="/themes")return "themes";if(p==="/developers"||p==="/publish")return "developers";return "extensions";}
  function go(v,replace){
    if(v===state.view){movePill();return;}
    showView(v);
    try{var u=pathFor(v);if(replace)history.replaceState({},"",u);else history.pushState({},"",u);}catch(e){}
  }
  function showView(v){
    state.view=v;
    [].forEach.call(document.querySelectorAll(".view"),function(el){el.classList.remove("on","anim");});
    var el=$("view-"+v);el.classList.add("on");void el.offsetWidth;el.classList.add("anim");
    movePill();
    window.scrollTo({top:0,behavior:"smooth"});
    if(v==="extensions")loadExtensions();
    else if(v==="themes")loadThemes();
    else renderDev();
  }

  // ── extensions ──
  function skeletons(host,n){var h="";for(var i=0;i<n;i++)h+='<div class="sk"></div>';host.innerHTML=h;}
  function loadExtensions(force){
    var grid=$("grid-ext");
    if(state.ext&&!force){renderExtensions();return;}
    if(state.extLoad)return;state.extLoad=true;skeletons(grid,6);
    fetch("/api/addons").then(function(r){return r.json();}).then(function(list){
      state.ext=Array.isArray(list)?list:[];state.extLoad=false;renderExtensions();
    }).catch(function(){state.extLoad=false;grid.innerHTML='<div class="empty">Could not load extensions. Try again shortly.</div>';});
  }
  function renderExtensions(){
    var grid=$("grid-ext"),q=($("search-ext").value||"").toLowerCase().trim();
    var list=(state.ext||[]).filter(function(a){return !q||((a.name||"")+" "+(a.description||"")+" "+(a.author||"")).toLowerCase().indexOf(q)>=0;});
    $("count-ext").textContent=(state.ext||[]).length+" total";
    if(!list.length){grid.innerHTML='<div class="empty">'+(q?"No extensions match \\u201c"+esc(q)+"\\u201d.":"No extensions published yet. Be the first \\u2014 open the Developer hub.")+'</div>';return;}
    grid.innerHTML=list.map(function(a,i){
      var h=hue(a.id||a.name);
      return '<div class="card" data-ext="'+esc(a.id)+'" style="animation-delay:'+(i*40)+'ms">'+
        '<div class="ext-top"><div class="ic" style="background:linear-gradient(135deg,hsl('+h+',70%,58%),hsl('+((h+40)%360)+',70%,52%))">'+esc(initials(a.name).toUpperCase())+'</div>'+
        '<div style="min-width:0"><div class="nm">'+esc(a.name)+'</div><div class="by">by '+esc(a.author||a.handle||"unknown")+'</div></div></div>'+
        '<div class="ds">'+esc(a.description||"A Pace extension.")+'</div>'+
        '<div class="card-foot"><span class="meta-s">'+dlIcon()+num(a.downloads)+' installs</span>'+
        '<button class="btn btn-p btn-sm" data-get-ext="'+esc(a.id)+'">Install</button></div></div>';
    }).join("");
  }

  // ── themes ──
  function loadThemes(force){
    var grid=$("grid-thm");
    if(state.thm&&!force){renderThemes();return;}
    if(state.thmLoad)return;state.thmLoad=true;skeletons(grid,6);
    fetch("/api/themes").then(function(r){return r.json();}).then(function(list){
      state.thm=Array.isArray(list)?list:[];state.thmLoad=false;renderThemes();
    }).catch(function(){state.thmLoad=false;grid.innerHTML='<div class="empty">Could not load themes. Try again shortly.</div>';});
  }
  function themePreview(p){
    p=p||{};
    var bg="linear-gradient(160deg,"+(p.bg0||"#0a0a12")+","+(p.bg1||"#10101c")+")";
    return '<div class="tprev" style="background:'+bg+'">'+
      '<div class="tprev-bar" style="background:'+(p.glass||"rgba(255,255,255,.06)")+'">'+
        '<div class="tprev-dots"><i style="background:'+(p.accent||"#5b8ef0")+'"></i><i style="background:'+(p.accent2||"#a78bfa")+'"></i><i style="background:'+(p.text2||"#aab0bd")+'"></i></div>'+
        '<div class="tprev-tab" style="background:'+(p.active||"rgba(255,255,255,.1)")+';color:'+(p.text1||"#fff")+'">Tab</div>'+
        '<div class="tprev-addr" style="background:'+(p.glass2||"rgba(255,255,255,.04)")+';color:'+(p.text2||"#aab0bd")+'">paceapp.dev</div>'+
      '</div>'+
      '<div class="tprev-body">'+
        '<div class="tprev-line" style="width:70%;background:'+(p.text2||"#aab0bd")+'"></div>'+
        '<div class="tprev-line" style="width:48%;background:'+(p.text2||"#aab0bd")+';opacity:.6"></div>'+
        '<div class="tprev-chips"><i style="background:'+(p.accent||"#5b8ef0")+'"></i><i style="background:'+(p.glass||"rgba(255,255,255,.06)")+'"></i><i style="background:'+(p.accent2||"#a78bfa")+';opacity:.7"></i></div>'+
      '</div></div>';
  }
  function renderThemes(){
    var grid=$("grid-thm"),q=($("search-thm").value||"").toLowerCase().trim();
    var list=(state.thm||[]).filter(function(a){return !q||((a.name||"")+" "+(a.description||"")+" "+(a.author||"")).toLowerCase().indexOf(q)>=0;});
    $("count-thm").textContent=(state.thm||[]).length+" total";
    if(!list.length){grid.innerHTML='<div class="empty">'+(q?"No themes match \\u201c"+esc(q)+"\\u201d.":"No themes yet.")+'</div>';return;}
    grid.innerHTML=list.map(function(a,i){
      return '<div class="card" data-thm="'+esc(a.id)+'" style="animation-delay:'+(i*40)+'ms">'+
        themePreview(a.preview)+
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px"><div style="min-width:0"><div class="nm">'+esc(a.name)+(a.featured?' <span class="pillv">Built-in</span>':'')+'</div><div class="by">by '+esc(a.author||a.handle||"unknown")+'</div></div>'+
        '<button class="btn btn-p btn-sm" data-get-thm="'+esc(a.id)+'">Install</button></div></div>';
    }).join("");
  }

  function dlIcon(){return '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" style="margin-right:1px"><path d="M7 1v8m0 0L4 6m3 3l3-3M2 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';}

  // ── detail modal ──
  function openExtModal(id){
    var a=(state.ext||[]).find(function(x){return x.id===id;});if(!a)return;
    var h=hue(a.id||a.name);
    showModal(
      '<div class="ext-top" style="margin-bottom:18px"><div class="ic" style="width:60px;height:60px;font-size:25px;border-radius:17px;background:linear-gradient(135deg,hsl('+h+',70%,58%),hsl('+((h+40)%360)+',70%,52%))">'+esc(initials(a.name).toUpperCase())+'</div>'+
      '<div style="min-width:0"><div style="font-size:21px;font-weight:680;letter-spacing:-.02em">'+esc(a.name)+'</div><div class="by">by '+esc(a.author||a.handle||"unknown")+' \\u00b7 v'+esc(a.version||"1.0.0")+'</div></div></div>'+
      '<p style="color:var(--t2);font-size:14.5px;line-height:1.6;margin-bottom:20px">'+esc(a.description||"A Pace extension.")+'</p>'+
      '<div style="display:flex;align-items:center;gap:14px;color:var(--t3);font-size:13px;margin-bottom:22px">'+dlIcon()+num(a.downloads)+' installs</div>'+
      '<button class="btn btn-p" style="width:100%" data-get-ext="'+esc(a.id)+'">Install extension</button>'+
      '<p class="muted">Downloads a .paceaddon file \\u2014 open it from Pace \\u2192 Extensions to install.</p>'
    );
  }
  function openThmModal(id){
    var a=(state.thm||[]).find(function(x){return x.id===id;});if(!a)return;
    showModal(
      themePreview(a.preview)+
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:6px 0 18px"><div><div style="font-size:21px;font-weight:680;letter-spacing:-.02em">'+esc(a.name)+(a.featured?' <span class="pillv">Built-in</span>':'')+'</div><div class="by">by '+esc(a.author||a.handle||"unknown")+' \\u00b7 v'+esc(a.version||"1.0.0")+'</div></div></div>'+
      '<p style="color:var(--t2);font-size:14.5px;line-height:1.6;margin-bottom:22px">'+esc(a.description||"A Pace theme.")+'</p>'+
      '<button class="btn btn-p" style="width:100%" data-get-thm="'+esc(a.id)+'">Install theme</button>'+
      '<p class="muted">Installs into Pace and applies instantly. Manage it any time under Themes.</p>'
    );
  }
  function showModal(html){
    $("modal-card").innerHTML='<button class="modal-close" data-close="1">\\u00d7</button>'+html;
    $("modal").classList.add("on");
  }
  function closeModal(){$("modal").classList.remove("on");}

  function getExt(id){window.location.href="/download/"+encodeURIComponent(id);toast("Starting download\\u2026","ok");}
  function getThm(id){window.location.href="/download-theme/"+encodeURIComponent(id);toast("Installing theme\\u2026","ok");}

  // ── developer hub ──
  function renderDev(){
    var root=$("dev-root");
    if(state.user)renderDashboard(root);else renderAuth(root);
  }
  function renderAuth(root){
    root.innerHTML=
      '<div class="hero" style="padding:54px 0 8px"><div class="eyebrow"><span class="dot"></span> Developer hub</div>'+
      '<h1 style="font-size:clamp(32px,5vw,50px)">Ship to Pace.</h1>'+
      '<p>Create a developer account to publish extensions and themes to the Pace Shop.</p></div>'+
      '<div class="auth-card">'+
        '<div class="auth-seg" id="aseg"><span class="ind"></span><button data-mode="in" class="on">Sign in</button><button data-mode="up">Create account</button></div>'+
        '<div id="auth-body"></div>'+
      '</div>';
    bindAuthSeg();renderAuthForm();
  }
  function bindAuthSeg(){
    [].forEach.call($("aseg").querySelectorAll("button"),function(b){
      b.onclick=function(){
        state.authMode=b.getAttribute("data-mode");
        [].forEach.call($("aseg").querySelectorAll("button"),function(x){x.classList.toggle("on",x===b);});
        $("aseg").classList.toggle("r",state.authMode==="up");
        renderAuthForm();
      };
    });
  }
  function renderAuthForm(){
    var body=$("auth-body");
    if(state.authMode==="up"){
      body.innerHTML=
        '<div class="row2"><div class="field"><label>Developer name</label><input id="f-name" placeholder="Jane Doe"></div>'+
        '<div class="field"><label>Public handle</label><input id="f-handle" placeholder="janedev"></div></div>'+
        '<div class="field"><label>Email</label><input id="f-email" type="email" placeholder="you@example.com"></div>'+
        '<div class="field"><label>Password</label><input id="f-pass" type="password" placeholder="At least 8 characters"></div>'+
        '<div class="form-msg" id="auth-msg"></div>'+
        '<button class="btn btn-p" style="width:100%;margin-top:6px" id="auth-go">Create account</button>'+
        '<p class="muted">Your email stays private \\u2014 only your name and handle are shown publicly.</p>';
    } else {
      body.innerHTML=
        '<div class="field"><label>Email</label><input id="f-email" type="email" placeholder="you@example.com"></div>'+
        '<div class="field"><label>Password</label><input id="f-pass" type="password" placeholder="Your password"></div>'+
        '<div class="form-msg" id="auth-msg"></div>'+
        '<button class="btn btn-p" style="width:100%;margin-top:6px" id="auth-go">Sign in</button>'+
        '<p class="muted">New here? Switch to <b>Create account</b> above.</p>';
    }
    $("auth-go").onclick=submitAuth;
    [].forEach.call(body.querySelectorAll("input"),function(inp){inp.onkeydown=function(e){if(e.key==="Enter")submitAuth();};});
  }
  function submitAuth(){
    var msg=$("auth-msg");msg.className="form-msg";msg.textContent="";
    var email=(($("f-email")||{}).value||"").trim(),pass=(($("f-pass")||{}).value||"");
    var btn=$("auth-go");btn.disabled=true;var label=btn.textContent;btn.textContent="Please wait\\u2026";
    var done=function(){btn.disabled=false;btn.textContent=label;};
    if(state.authMode==="up"){
      var name=(($("f-name")||{}).value||"").trim(),handle=(($("f-handle")||{}).value||"").trim();
      api("/api/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:email,password:pass,name:name,handle:handle})}).then(function(res){
        done();
        if(res.body&&res.body.ok){saveSession(res.body.token,res.body.user);toast("Welcome, "+res.body.user.name+"!","ok");renderDev();}
        else{msg.className="form-msg err";msg.textContent=(res.body&&res.body.error)||"Could not create account.";}
      }).catch(function(){done();msg.className="form-msg err";msg.textContent="Network error.";});
    } else {
      api("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:email,password:pass})}).then(function(res){
        done();
        if(res.body&&res.body.ok){saveSession(res.body.token,res.body.user);toast("Signed in","ok");renderDev();}
        else{msg.className="form-msg err";msg.textContent=(res.body&&res.body.error)||"Could not sign in.";}
      }).catch(function(){done();msg.className="form-msg err";msg.textContent="Network error.";});
    }
  }
  function renderDashboard(root){
    root.innerHTML=
      '<div class="dash-head"><div><h2>Welcome back, '+esc(state.user.name)+'</h2><p>Publish a new release or manage what you\\u2019ve shipped.</p></div>'+
      '<button class="btn btn-g btn-sm" id="signout">Sign out</button></div>'+
      '<div class="pub-grid">'+
        publishCard("extension")+
        publishCard("theme")+
      '</div>'+
      '<div class="sec-head" style="margin-top:42px"><h2>Your published items</h2><span class="count" id="mine-count"></span></div>'+
      '<div class="grid" id="grid-mine"></div>';
    $("signout").onclick=function(){clearSession();toast("Signed out");renderDev();};
    bindPublish("extension");bindPublish("theme");
    loadMine();
  }
  function publishCard(kind){
    var isT=kind==="theme";
    return '<div class="pub-card"><h3>Publish '+(isT?'a theme':'an extension')+' <span class="badge'+(isT?' t':'')+'">'+(isT?'.pacetheme':'.paceaddon')+'</span></h3>'+
      '<div class="hint">'+(isT?'Re-skins the browser chrome.':'Adds functionality to Pace.')+'</div>'+
      '<div class="row2"><div class="field"><label>Identifier</label><input id="p-'+kind+'-id" placeholder="'+(isT?'my-theme':'my-extension')+'"></div>'+
      '<div class="field"><label>Version</label><input id="p-'+kind+'-ver" placeholder="1.0.0"></div></div>'+
      '<div class="field"><label>Name</label><input id="p-'+kind+'-name" placeholder="'+(isT?'My Theme':'My Extension')+'"></div>'+
      '<div class="field"><label>Description</label><textarea id="p-'+kind+'-desc" placeholder="What it does"></textarea></div>'+
      '<div class="drop" id="p-'+kind+'-drop"><div>Drop your <b>'+(isT?'.pacetheme':'.paceaddon')+'</b> here, or click to browse</div><div class="fn" id="p-'+kind+'-fn"></div>'+
      '<input type="file" id="p-'+kind+'-file" accept="'+(isT?'.pacetheme':'.paceaddon')+'" style="display:none"></div>'+
      '<label class="chk"><input type="checkbox" id="p-'+kind+'-agree"> I have the rights to publish this and agree to the Pace Developer Agreement.</label>'+
      '<div class="form-msg" id="p-'+kind+'-msg"></div>'+
      '<button class="btn btn-p" style="width:100%" id="p-'+kind+'-go">Publish '+(isT?'theme':'extension')+'</button></div>';
  }
  function bindPublish(kind){
    var drop=$("p-"+kind+"-drop"),file=$("p-"+kind+"-file"),fn=$("p-"+kind+"-fn");
    drop.onclick=function(){file.click();};
    file.onchange=function(){fn.textContent=file.files&&file.files[0]?file.files[0].name:"";};
    ["dragenter","dragover"].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.add("over");});});
    ["dragleave","drop"].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.remove("over");});});
    drop.addEventListener("drop",function(e){if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]){file.files=e.dataTransfer.files;fn.textContent=e.dataTransfer.files[0].name;}});
    $("p-"+kind+"-go").onclick=function(){submitPublish(kind);};
  }
  function submitPublish(kind){
    var msg=$("p-"+kind+"-msg");msg.className="form-msg";msg.textContent="";
    var id=(($("p-"+kind+"-id")||{}).value||"").trim();
    var name=(($("p-"+kind+"-name")||{}).value||"").trim();
    var ver=(($("p-"+kind+"-ver")||{}).value||"1.0.0").trim();
    var desc=(($("p-"+kind+"-desc")||{}).value||"").trim();
    var agree=($("p-"+kind+"-agree")||{}).checked;
    var fileEl=$("p-"+kind+"-file");var f=fileEl&&fileEl.files?fileEl.files[0]:null;
    if(!agree){msg.className="form-msg err";msg.textContent="Please accept the developer agreement.";return;}
    if(!f){msg.className="form-msg err";msg.textContent="Choose a "+(kind==="theme"?".pacetheme":".paceaddon")+" file.";return;}
    var fd=new FormData();
    fd.append("kind",kind);fd.append("id",id);fd.append("name",name);fd.append("version",ver);fd.append("description",desc);fd.append("agree","true");fd.append("file",f);
    var btn=$("p-"+kind+"-go");btn.disabled=true;var label=btn.textContent;btn.textContent="Publishing\\u2026";
    api("/api/publish",{method:"POST",body:fd}).then(function(res){
      btn.disabled=false;btn.textContent=label;
      if(res.body&&res.body.ok){
        msg.className="form-msg ok";msg.textContent="Published \\u201c"+res.body.name+"\\u201d \\u2014 live now.";
        toast("Published "+res.body.name,"ok");
        if(kind==="theme")state.thm=null;else state.ext=null;
        loadMine();
      } else if(res.status===401){clearSession();renderDev();toast("Session expired \\u2014 sign in again","err");}
      else{msg.className="form-msg err";msg.textContent=(res.body&&res.body.error)||"Publish failed.";}
    }).catch(function(){btn.disabled=false;btn.textContent=label;msg.className="form-msg err";msg.textContent="Network error during upload.";});
  }
  function loadMine(){
    var grid=$("grid-mine");if(!grid)return;grid.innerHTML='<div class="loading-note">Loading your items\\u2026</div>';
    api("/api/my-items").then(function(res){
      if(!res.body||!res.body.ok){grid.innerHTML='<div class="empty">Could not load your items.</div>';if($("mine-count"))$("mine-count").textContent="";return;}
      var items=res.body.items||[];
      if($("mine-count"))$("mine-count").textContent=items.length+" total";
      if(!items.length){grid.innerHTML='<div class="empty">Nothing published yet. Use the cards above to ship your first release.</div>';return;}
      grid.innerHTML=items.map(function(a){
        if(a.kind==="theme"){
          return '<div class="card" style="cursor:default">'+themePreview(a.preview)+'<div class="nm">'+esc(a.name)+' <span class="pillv">Theme</span></div><div class="card-foot"><span class="meta-s">'+dlIcon()+num(a.downloads)+' \\u00b7 v'+esc(a.version)+'</span></div></div>';
        }
        var h=hue(a.id||a.name);
        return '<div class="card" style="cursor:default"><div class="ext-top"><div class="ic" style="background:linear-gradient(135deg,hsl('+h+',70%,58%),hsl('+((h+40)%360)+',70%,52%))">'+esc(initials(a.name).toUpperCase())+'</div><div style="min-width:0"><div class="nm">'+esc(a.name)+' <span class="pillv">Extension</span></div><div class="by">v'+esc(a.version)+'</div></div></div><div class="card-foot"><span class="meta-s">'+dlIcon()+num(a.downloads)+' installs</span></div></div>';
      }).join("");
    }).catch(function(){grid.innerHTML='<div class="empty">Could not load your items.</div>';});
  }

  // ── global delegated clicks ──
  document.addEventListener("click",function(e){
    var t=e.target;
    var go1=t.closest&&t.closest("[data-go]");if(go1){e.preventDefault();go(go1.getAttribute("data-go"));return;}
    var gx=t.closest&&t.closest("[data-get-ext]");if(gx){e.stopPropagation();getExt(gx.getAttribute("data-get-ext"));return;}
    var gt=t.closest&&t.closest("[data-get-thm]");if(gt){e.stopPropagation();getThm(gt.getAttribute("data-get-thm"));return;}
    var cx=t.closest&&t.closest("[data-ext]");if(cx){openExtModal(cx.getAttribute("data-ext"));return;}
    var ct=t.closest&&t.closest("[data-thm]");if(ct){openThmModal(ct.getAttribute("data-thm"));return;}
    if(t.getAttribute&&t.getAttribute("data-close")){closeModal();return;}
  });
  document.addEventListener("keydown",function(e){if(e.key==="Escape")closeModal();});
  window.addEventListener("popstate",function(){showView(viewFromPath(location.pathname));});
  window.addEventListener("resize",movePill);
  var se=$("search-ext"),st=$("search-thm");
  if(se)se.addEventListener("input",renderExtensions);
  if(st)st.addEventListener("input",renderThemes);

  // ── boot ──
  loadSession();renderNav();
  showView(viewFromPath(location.pathname));
  try{history.replaceState({},"",pathFor(state.view));}catch(e){}
  // validate the stored session quietly
  if(state.token){api("/api/me").then(function(res){if(!res.body||!res.body.ok){clearSession();}else{state.user=res.body.user;try{localStorage.setItem(USER_KEY,JSON.stringify(state.user));}catch(e){}renderNav();if(state.view==="developers")renderDev();}}).catch(function(){});}
})();
</script>
</body></html>`;
}
