// ─────────────────────────────────────────────────────────────────────────────
//  Pace Addon Shop — Cloudflare Worker
//  Storefront + JSON API + developer publishing, backed entirely by Cloudflare R2.
//
//  Storage layout in the R2 bucket (binding: ADDONS):
//    index.json                      → array of addon summaries (the catalog)
//    addons/<id>/addon.json          → full metadata for one addon
//    addons/<id>/<id>.paceaddon      → the addon package (a zip of the addon folder)
//
//  Publishing is protected by a secret token (env.PUBLISH_TOKEN). Only requests that
//  present the matching token may publish. (A full developer-account system is a later phase.)
//
//  Deploy: see README.md in this folder.
// ─────────────────────────────────────────────────────────────────────────────

const ACCENT = '#5b8ef0';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();
    try {
      if (path === '/' && method === 'GET') return htmlResponse(storefrontPage());
      if (path === '/publish' && method === 'GET') return htmlResponse(publishPage());

      if (path === '/api/addons' && method === 'GET') return jsonResponse(await readIndex(env));
      if (path.startsWith('/api/addon/') && method === 'GET') {
        const id = decodeURIComponent(path.slice('/api/addon/'.length));
        const meta = await readAddonMeta(env, id);
        return meta ? jsonResponse(meta) : jsonResponse({ ok: false, error: 'Addon not found' }, 404);
      }
      if (path.startsWith('/download/') && method === 'GET') {
        return await handleDownload(env, decodeURIComponent(path.slice('/download/'.length)));
      }
      if (path === '/api/publish' && method === 'POST') return await handlePublish(request, env);
      if (path === '/api/publish' && method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return jsonResponse({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  }
};

// ── Backblaze B2 (native API) ────────────────────────────────────────────────
// Auth token is cached at module scope (valid ~24h) so we re-authorize rarely. Reads use the
// download URL with the auth token, so the bucket can stay PRIVATE. Writes go through the upload-url flow.
let _b2 = null; // { token, apiUrl, downloadUrl, ts }
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

async function readIndex(env) {
  try { const txt = await b2GetText(env, 'index.json'); if (!txt) return []; const arr = JSON.parse(txt); return Array.isArray(arr) ? arr : []; }
  catch (e) { return []; }
}
async function writeIndex(env, arr) {
  await b2Upload(env, 'index.json', new TextEncoder().encode(JSON.stringify(arr, null, 2)), 'application/json');
}
async function readAddonMeta(env, id) {
  try { const txt = await b2GetText(env, 'addons/' + safeId(id) + '/addon.json'); return txt ? JSON.parse(txt) : null; }
  catch (e) { return null; }
}

async function handleDownload(env, id) {
  const name = 'addons/' + safeId(id) + '/' + safeId(id) + '.paceaddon';
  const r = await b2GetStream(env, name);
  if (!r.ok) return new Response('Addon package not found', { status: 404 });
  // best-effort download counter
  try {
    const idx = await readIndex(env);
    const e = idx.find(a => a.id === id);
    if (e) { e.downloads = (e.downloads || 0) + 1; await writeIndex(env, idx); }
  } catch (e) {}
  return new Response(r.body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="' + safeId(id) + '.paceaddon"',
      'Cache-Control': 'no-store'
    }
  });
}

// ── Publishing ──────────────────────────────────────────────────────────────
async function handlePublish(request, env) {
  const form = await request.formData();
  const token = String(form.get('token') || '');
  if (!env.PUBLISH_TOKEN || token !== env.PUBLISH_TOKEN) {
    return cors(jsonResponse({ ok: false, error: 'Invalid publish token.' }, 401));
  }
  if (form.get('agree') !== 'on' && form.get('agree') !== 'true') {
    return cors(jsonResponse({ ok: false, error: 'You must accept the developer agreement.' }, 400));
  }
  const id = safeId(String(form.get('id') || ''));
  const name = String(form.get('name') || '').trim();
  const version = String(form.get('version') || '1.0.0').trim();
  const description = String(form.get('description') || '').trim();
  const author = String(form.get('author') || '').trim();
  const email = String(form.get('email') || '').trim();
  const handle = String(form.get('handle') || '').trim().replace(/^@+/, '').slice(0, 40);
  const file = form.get('file');
  if (!id) return cors(jsonResponse({ ok: false, error: 'A valid id is required (letters, numbers, - _ .).' }, 400));
  if (!name) return cors(jsonResponse({ ok: false, error: 'A name is required.' }, 400));
  if (!author) return cors(jsonResponse({ ok: false, error: 'A developer display name is required.' }, 400));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return cors(jsonResponse({ ok: false, error: 'A valid contact email is required.' }, 400));
  if (!file || typeof file.arrayBuffer !== 'function') {
    return cors(jsonResponse({ ok: false, error: 'A .paceaddon package file is required.' }, 400));
  }
  if (!/\.paceaddon$/i.test(String(file.name || ''))) {
    return cors(jsonResponse({ ok: false, error: 'Only .paceaddon files can be uploaded.' }, 400));
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) return cors(jsonResponse({ ok: false, error: 'The package file is empty.' }, 400));
  if (bytes.byteLength > 5 * 1024 * 1024) return cors(jsonResponse({ ok: false, error: 'Package too large (max 5 MB).' }, 400));

  const now = new Date().toISOString();
  // Public metadata (served to the storefront) — never includes the developer's email.
  const meta = { id, name, version, description, author, handle, updated: now, size: bytes.byteLength };
  // Private accountability record — kept in B2, never served by any public route.
  const publisher = { id, author, email, handle, agreedAt: now, version,
    ip: request.headers.get('CF-Connecting-IP') || '', ua: request.headers.get('User-Agent') || '' };

  // store package + metadata + private publisher record
  await b2Upload(env, 'addons/' + id + '/' + id + '.paceaddon', bytes, 'application/zip');
  await b2Upload(env, 'addons/' + id + '/addon.json', new TextEncoder().encode(JSON.stringify(meta, null, 2)), 'application/json');
  await b2Upload(env, 'addons/' + id + '/publisher.json', new TextEncoder().encode(JSON.stringify(publisher, null, 2)), 'application/json');

  // update catalog (preserve download count)
  const idx = await readIndex(env);
  const existing = idx.find(a => a.id === id);
  const downloads = existing ? (existing.downloads || 0) : 0;
  const summary = { id, name, version, description, author, handle, updated: now, downloads };
  const pos = idx.findIndex(a => a.id === id);
  if (pos >= 0) idx[pos] = summary; else idx.push(summary);
  idx.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  await writeIndex(env, idx);

  return cors(jsonResponse({ ok: true, id, name, version }));
}

// ── utilities ─────────────────────────────────────────────────────────────────
function safeId(s) { return String(s).replace(/[^a-z0-9_.-]/gi, '').slice(0, 80); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function htmlResponse(body) { return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function cors(resp) {
  resp.headers.set('Access-Control-Allow-Origin', '*');
  resp.headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  resp.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return resp;
}

// ── Pages ──────────────────────────────────────────────────────────────────────
function shell(title, inner) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{--acc:${ACCENT};--acc-soft:color-mix(in srgb,${ACCENT} 15%,transparent);--bg:#08080c;--card:#101017;--t1:#f4f5fa;--t2:#9b9faf;--t3:#6b6f7f;--line:rgba(255,255,255,.07);--line2:rgba(255,255,255,.12);--glass:rgba(255,255,255,.035);--ok:#5bd6a0;--err:#ff6b73;--r:16px;--r-sm:11px}
  *{box-sizing:border-box}
  html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  body{margin:0;font:15px/1.6 -apple-system,'Segoe UI',Roboto,system-ui,sans-serif;color:var(--t1);
    background:radial-gradient(1200px 620px at 50% -22%,color-mix(in srgb,${ACCENT} 11%,transparent),transparent 72%),var(--bg);min-height:100vh}
  a{color:var(--t1);text-decoration:none}
  ::selection{background:var(--acc-soft)}
  .wrap{max-width:900px;margin:0 auto;padding:48px 24px 64px}
  header{display:flex;align-items:center;gap:14px;margin-bottom:8px}
  .logo{width:44px;height:44px;border-radius:13px;background:linear-gradient(150deg,var(--acc),color-mix(in srgb,var(--acc) 60%,#000));display:flex;align-items:center;justify-content:center;box-shadow:0 12px 30px -10px var(--acc)}
  .logo svg{width:23px;height:23px;display:block}
  h1{font-size:27px;margin:0;font-weight:700;letter-spacing:-.6px}
  .sub{color:var(--t2);margin:4px 0 26px;font-size:15px}
  .nav{display:flex;gap:8px;margin-bottom:28px}
  .nav a{font-size:13.5px;color:var(--t2);padding:8px 14px;border-radius:10px;transition:.15s;font-weight:500}
  .nav a:hover{color:var(--t1);background:var(--glass)}
  .nav a.cta{color:var(--acc);background:var(--acc-soft)}
  .nav a.cta:hover{filter:brightness(1.18)}
  .search{width:100%;padding:14px 16px;border-radius:13px;background:var(--glass);border:1px solid var(--line);color:var(--t1);font-size:15px;margin-bottom:22px;outline:none;transition:.15s}
  .search::placeholder{color:var(--t3)}
  .search:focus{border-color:var(--line2);background:rgba(255,255,255,.05)}
  .grid{display:flex;flex-direction:column;gap:10px}
  .card{display:flex;gap:16px;align-items:center;padding:17px 19px;border-radius:var(--r);background:var(--card);border:1px solid var(--line);transition:transform .16s,border-color .16s,background .16s}
  .card:hover{transform:translateY(-2px);border-color:var(--line2);background:#13131c}
  .ic{width:48px;height:48px;border-radius:13px;background:var(--glass);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--acc)}
  .ic svg{width:24px;height:24px}
  .meta{flex:1;min-width:0}
  .nm{font-weight:650;font-size:16px;letter-spacing:-.2px;display:flex;align-items:center;flex-wrap:wrap;gap:7px}
  .by{color:var(--t3);font-size:12.5px;margin-top:2px}
  .ds{color:var(--t2);font-size:13.5px;margin-top:5px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .pill{font-size:10.5px;font-weight:600;letter-spacing:.02em;color:var(--t2);background:var(--glass);border:1px solid var(--line);padding:2px 8px;border-radius:20px}
  .btn{flex-shrink:0;padding:10px 18px;border-radius:11px;border:none;background:var(--acc);color:#fff;font-weight:600;font-size:14px;cursor:pointer;text-decoration:none;white-space:nowrap;transition:filter .15s;font-family:inherit}
  .btn:hover{filter:brightness(1.1)}
  .btn.ghost{background:var(--glass);color:var(--t1);border:1px solid var(--line2)}
  .btn.ghost:hover{background:rgba(255,255,255,.06);filter:none}
  .btn.block{width:100%;padding:14px;font-size:15px;text-align:center;margin-top:6px}
  .btn:disabled{opacity:.55;cursor:default;filter:none}
  .empty{padding:46px 30px;text-align:center;color:var(--t3);border:1px dashed var(--line2);border-radius:var(--r);background:var(--glass);font-size:14px}
  .note{margin-top:30px;padding:18px 20px;border-radius:var(--r);background:var(--glass);border:1px solid var(--line);color:var(--t2);font-size:13.5px;line-height:1.65}
  .note b{color:var(--t1);font-weight:600}
  code{background:rgba(255,255,255,.06);padding:2px 7px;border-radius:6px;color:var(--acc);font-size:12.5px;font-family:'SF Mono',ui-monospace,Menlo,monospace}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:8px 24px 26px}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:560px){.row2{grid-template-columns:1fr}}
  label{display:block;font-size:12.5px;color:var(--t2);margin:16px 0 6px;font-weight:500}
  label .opt{color:var(--t3);font-weight:400}
  input[type=text],input[type=email],input[type=password],textarea{width:100%;padding:12px 14px;border-radius:var(--r-sm);background:var(--glass);border:1px solid var(--line);color:var(--t1);font-size:14px;outline:none;font-family:inherit;transition:.15s}
  input::placeholder,textarea::placeholder{color:var(--t3)}
  input:focus,textarea:focus{border-color:var(--line2);background:rgba(255,255,255,.05)}
  input[type=file]{width:100%;padding:11px 14px;border-radius:var(--r-sm);background:var(--glass);border:1px dashed var(--line2);color:var(--t2);font-size:13px;font-family:inherit}
  input[type=file]::file-selector-button{background:var(--glass);border:1px solid var(--line2);color:var(--t1);padding:7px 13px;border-radius:8px;font-size:13px;margin-right:12px;cursor:pointer;font-family:inherit}
  textarea{min-height:80px;resize:vertical}
  .agreement{max-height:168px;overflow:auto;padding:16px 18px;border-radius:var(--r-sm);background:rgba(0,0,0,.28);border:1px solid var(--line);font-size:12.5px;color:var(--t2);line-height:1.65;margin-top:6px}
  .agreement b{color:var(--t1)}
  .agree{display:flex;gap:10px;align-items:flex-start;margin:16px 0 4px;color:var(--t2);font-size:13px;line-height:1.5;cursor:pointer}
  .agree input{margin-top:2px;accent-color:var(--acc);width:16px;height:16px;flex-shrink:0}
  .sechead{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--t3);font-weight:600;margin:24px 0 2px}
  #msg{margin-top:16px;font-size:14px;line-height:1.5}
  .foot{margin-top:46px;padding-top:22px;border-top:1px solid var(--line);color:var(--t3);font-size:12.5px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px}
</style></head><body><div class="wrap">${inner}
  <div class="foot"><span>Pace Addon Shop</span><span>Addons run with your permission — install only what you trust.</span></div>
</div></body></html>`;
}

function storefrontPage() {
  return shell('Pace Addon Shop', `
  <header><div class="logo"><svg viewBox="0 0 24 24" fill="none"><path d="M13 2.2 4.4 13.4c-.45.6.02 1.45.78 1.45H11l-1 7.05c-.1.78.9 1.2 1.4.58L19.6 11.3c.46-.6-.02-1.45-.78-1.45H13l1-7c.1-.8-.9-1.2-1.4-.58Z" fill="#fff"/></svg></div><h1>Pace Addon Shop</h1></header>
  <div class="sub">Native addons for the Pace browser.</div>
  <div class="nav"><a href="/">Browse</a><a class="cta" href="/publish">Publish an addon →</a></div>
  <input class="search" id="q" placeholder="Search addons…" oninput="filter()">
  <div class="grid" id="grid"><div class="empty">Loading addons…</div></div>
  <div class="note">
    <b>Installing an addon.</b> Tap <b>Get</b> to download its <code>.paceaddon</code> file, then in Pace open
    <code>pace://extensions</code> → <b>Install from file</b> and choose it. Every addon is confirmed with a
    security prompt the first time, because an addon can read and change the pages you visit.
  </div>
  <script>
    const ICON='<svg viewBox="0 0 24 24" fill="none"><path d="M14 3.6a2 2 0 1 0-4 0V5H7.5A1.5 1.5 0 0 0 6 6.5V9H4.6a2 2 0 1 0 0 4H6v2.5A1.5 1.5 0 0 0 7.5 17H10v1.4a2 2 0 1 0 4 0V17h2.5a1.5 1.5 0 0 0 1.5-1.5V13h1.4a2 2 0 1 0 0-4H18V6.5A1.5 1.5 0 0 0 16.5 5H14V3.6Z" fill="currentColor" opacity=".92"/></svg>';
    let ALL=[];
    function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    function card(a){
      const dl=(a.downloads||0);
      return '<div class="card"><div class="ic">'+ICON+'</div>'+
        '<div class="meta"><div class="nm">'+esc(a.name)+'<span class="pill">v'+esc(a.version)+'</span>'+(dl?'<span class="pill">'+dl+' install'+(dl==1?'':'s')+'</span>':'')+'</div>'+
        '<div class="by">'+(a.author?('by '+esc(a.author)):'Unknown developer')+(a.handle?(' · @'+esc(a.handle)):'')+'</div>'+
        '<div class="ds">'+esc(a.description||'')+'</div></div>'+
        '<a class="btn" href="/download/'+encodeURIComponent(a.id)+'">Get</a></div>';
    }
    function render(list){
      const g=document.getElementById('grid');
      if(!list.length){ g.innerHTML='<div class="empty">No addons published yet. Be the first — <a href="/publish" style="color:var(--acc)">publish one</a>.</div>'; return; }
      g.innerHTML=list.map(card).join('');
    }
    function filter(){
      const q=document.getElementById('q').value.toLowerCase().trim();
      render(!q?ALL:ALL.filter(a=>((a.name||'')+' '+(a.description||'')+' '+(a.author||'')+' '+(a.handle||'')).toLowerCase().includes(q)));
    }
    fetch('/api/addons').then(r=>r.json()).then(d=>{ ALL=Array.isArray(d)?d:[]; render(ALL); }).catch(()=>{ document.getElementById('grid').innerHTML='<div class="empty">Could not load the catalog. Try again shortly.</div>'; });
  </script>`);
}

function publishPage() {
  return shell('Publish · Pace Addon Shop', `
  <header><div class="logo"><svg viewBox="0 0 24 24" fill="none"><path d="M13 2.2 4.4 13.4c-.45.6.02 1.45.78 1.45H11l-1 7.05c-.1.78.9 1.2 1.4.58L19.6 11.3c.46-.6-.02-1.45-.78-1.45H13l1-7c.1-.8-.9-1.2-1.4-.58Z" fill="#fff"/></svg></div><h1>Publish an addon</h1></header>
  <div class="sub">Submit a Pace Addon to the Shop. Publishing requires a verified developer identity.</div>
  <div class="nav"><a href="/">← Back to Shop</a></div>

  <div class="panel">
    <div class="sechead">Developer</div>
    <label>Display name</label>
    <input type="text" id="author" placeholder="Jane Developer" autocomplete="name">
    <div class="row2">
      <div><label>Contact email <span class="opt">(private — for takedowns & verification)</span></label>
        <input type="email" id="email" placeholder="you@example.com" spellcheck="false" autocomplete="email"></div>
      <div><label>Public handle <span class="opt">(optional)</span></label>
        <input type="text" id="handle" placeholder="janedev" spellcheck="false"></div>
    </div>

    <div class="sechead">Addon</div>
    <div class="row2">
      <div><label>Addon ID <span class="opt">(unique; a–z 0–9 - _ .)</span></label>
        <input type="text" id="id" placeholder="my-addon" spellcheck="false"></div>
      <div><label>Version</label>
        <input type="text" id="version" placeholder="1.0.0" value="1.0.0" spellcheck="false"></div>
    </div>
    <label>Name</label>
    <input type="text" id="name" placeholder="My Addon">
    <label>Description</label>
    <textarea id="description" placeholder="What does it do?"></textarea>
    <label>Package <span class="opt">(.paceaddon only — max 5 MB)</span></label>
    <input type="file" id="file" accept=".paceaddon">

    <div class="sechead">Authorization</div>
    <label>Publish token</label>
    <input type="password" id="token" placeholder="Your publish token" spellcheck="false" autocomplete="off">

    <div class="agreement">
      <b>Pace Developer Agreement</b><br>
      By submitting, you confirm under your stated identity that: (1) you have the right to distribute this addon
      and all its contents; (2) it contains no malware, spyware, miners, or code that harms users or their data;
      (3) it does not collect personal data without clear disclosure and consent; (4) it does not impersonate other
      addons, brands, or Pace itself; (5) it complies with applicable law. Your name and email are recorded with this
      submission for accountability. Addons may be removed at any time if they violate these terms. You remain
      responsible for your addon and any harm it causes. The Shop is provided "as is" with no warranty.
    </div>
    <label class="agree"><input type="checkbox" id="agree"> I am the developer named above and I accept the Pace Developer Agreement.</label>

    <button class="btn block" onclick="submitAddon(this)">Publish addon</button>
    <div id="msg"></div>
  </div>

  <script>
    const $=id=>document.getElementById(id);
    function fail(t){ const m=$('msg'); m.style.color='var(--err)'; m.textContent='✗ '+t; }
    async function submitAddon(btn){
      const author=$('author').value.trim(), email=$('email').value.trim(), f=$('file').files[0];
      if(!author){ return fail('Enter your developer display name.'); }
      if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)){ return fail('Enter a valid contact email.'); }
      if(!$('id').value.trim()){ return fail('Enter an addon ID.'); }
      if(!$('name').value.trim()){ return fail('Enter an addon name.'); }
      if(!f){ return fail('Choose a .paceaddon file.'); }
      if(!/\\.paceaddon$/i.test(f.name)){ return fail('Only .paceaddon files can be uploaded.'); }
      if(f.size>5*1024*1024){ return fail('Package too large (max 5 MB).'); }
      if(!$('agree').checked){ return fail('You must accept the Developer Agreement.'); }
      if(!$('token').value){ return fail('Enter your publish token.'); }
      const fd=new FormData();
      ['id','name','version','author','description','token'].forEach(k=>fd.append(k,$(k).value));
      fd.append('email',email); fd.append('handle',$('handle').value.trim());
      fd.append('agree','on'); fd.append('file',f);
      btn.disabled=true; const o=btn.textContent; btn.textContent='Publishing…';
      const m=$('msg'); m.style.color='var(--t2)'; m.textContent='Uploading…';
      try{
        const r=await fetch('/api/publish',{method:'POST',body:fd});
        const d=await r.json();
        if(d.ok){ m.style.color='var(--ok)'; m.innerHTML='✓ Published <b>'+d.name+'</b> v'+d.version+'. It is now live in the Shop.'; }
        else fail(d.error||'Publish failed.');
      }catch(e){ fail('Network error: '+e.message); }
      btn.disabled=false; btn.textContent=o;
    }
  </script>`);
}
