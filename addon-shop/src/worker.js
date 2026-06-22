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
  const file = form.get('file');
  if (!id) return cors(jsonResponse({ ok: false, error: 'A valid id is required (letters, numbers, - _ .).' }, 400));
  if (!name) return cors(jsonResponse({ ok: false, error: 'A name is required.' }, 400));
  if (!file || typeof file.arrayBuffer !== 'function') {
    return cors(jsonResponse({ ok: false, error: 'A .paceaddon package file is required.' }, 400));
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) return cors(jsonResponse({ ok: false, error: 'The package file is empty.' }, 400));
  if (bytes.byteLength > 10 * 1024 * 1024) return cors(jsonResponse({ ok: false, error: 'Package too large (max 10 MB).' }, 400));

  const meta = {
    id, name, version, description, author,
    updated: new Date().toISOString(),
    size: bytes.byteLength
  };

  // store package + metadata
  await b2Upload(env, 'addons/' + id + '/' + id + '.paceaddon', bytes, 'application/zip');
  await b2Upload(env, 'addons/' + id + '/addon.json', new TextEncoder().encode(JSON.stringify(meta, null, 2)), 'application/json');

  // update catalog (preserve download count)
  const idx = await readIndex(env);
  const existing = idx.find(a => a.id === id);
  const downloads = existing ? (existing.downloads || 0) : 0;
  const summary = { id, name, version, description, author, updated: meta.updated, downloads };
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
  :root{--acc:${ACCENT};--acc2:#a78bfa;--bg:#0b0b12;--t1:#f3f4fb;--t2:#a7abbd;--glass:rgba(255,255,255,.045);--glass2:rgba(255,255,255,.08);--line:rgba(255,255,255,.10);--r:14px}
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.55 -apple-system,Segoe UI,Roboto,system-ui,sans-serif;color:var(--t1);
    background:radial-gradient(1100px 560px at 18% -10%,rgba(91,142,240,.16),transparent),radial-gradient(900px 500px at 110% 8%,rgba(167,139,250,.12),transparent),var(--bg);min-height:100vh}
  a{color:var(--acc);text-decoration:none} a:hover{text-decoration:underline}
  .wrap{max-width:920px;margin:0 auto;padding:30px 22px 70px}
  header{display:flex;align-items:center;gap:13px;margin-bottom:6px}
  .logo{width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,var(--acc),var(--acc2));display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 8px 22px -6px rgba(91,142,240,.6)}
  h1{font-size:25px;margin:0;font-weight:750;letter-spacing:-.3px}
  .sub{color:var(--t2);margin:2px 0 22px}
  .nav{display:flex;gap:18px;margin-bottom:26px;font-size:14px}
  .search{width:100%;padding:12px 15px;border-radius:12px;background:var(--glass);border:1px solid var(--line);color:var(--t1);font-size:15px;margin-bottom:18px;outline:none}
  .search:focus{border-color:var(--acc)}
  .grid{display:flex;flex-direction:column;gap:12px}
  .card{display:flex;gap:15px;align-items:center;padding:16px 18px;border-radius:var(--r);background:var(--glass);border:1px solid var(--line);transition:.15s}
  .card:hover{background:var(--glass2);border-color:color-mix(in srgb,var(--acc) 38%,var(--line))}
  .ic{width:46px;height:46px;border-radius:12px;background:linear-gradient(135deg,rgba(91,142,240,.4),rgba(167,139,250,.4));display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
  .meta{flex:1;min-width:0}
  .nm{font-weight:650;font-size:16px}
  .by{color:var(--t2);font-size:12.5px}
  .ds{color:var(--t2);font-size:13.5px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .pill{font-size:11px;color:var(--t2);background:var(--glass2);padding:1px 8px;border-radius:20px;margin-left:7px}
  .btn{flex-shrink:0;padding:9px 16px;border-radius:10px;border:1px solid var(--acc);background:var(--acc);color:#fff;font-weight:600;font-size:14px;cursor:pointer;text-decoration:none;white-space:nowrap}
  .btn:hover{filter:brightness(1.08);text-decoration:none}
  .btn.ghost{background:transparent;color:var(--acc)}
  .empty{padding:34px;text-align:center;color:var(--t2);border:1px dashed var(--line);border-radius:var(--r);background:var(--glass)}
  .note{margin-top:24px;padding:16px 18px;border-radius:var(--r);background:var(--glass);border:1px solid var(--line);color:var(--t2);font-size:13.5px}
  .note b{color:var(--t1)} code{background:var(--glass2);padding:1px 6px;border-radius:5px;color:var(--acc);font-size:13px}
  label{display:block;font-size:13px;color:var(--t2);margin:14px 0 5px}
  input[type=text],input[type=password],textarea{width:100%;padding:11px 13px;border-radius:10px;background:var(--glass);border:1px solid var(--line);color:var(--t1);font-size:14px;outline:none;font-family:inherit}
  input:focus,textarea:focus{border-color:var(--acc)}
  textarea{min-height:74px;resize:vertical}
  .agree{display:flex;gap:9px;align-items:flex-start;margin:16px 0;color:var(--t2);font-size:13px}
  .agreement{max-height:200px;overflow:auto;padding:14px;border-radius:10px;background:rgba(0,0,0,.25);border:1px solid var(--line);font-size:12.5px;color:var(--t2);margin-top:6px}
  #msg{margin-top:14px;font-size:14px}
</style></head><body><div class="wrap">${inner}</div></body></html>`;
}

function storefrontPage() {
  return shell('Pace Addon Shop', `
  <header><div class="logo">⚡</div><h1>Pace Addon Shop</h1></header>
  <div class="sub">Native addons for the Pace browser.</div>
  <div class="nav"><a href="/">Browse</a><a href="/publish">Publish an addon →</a></div>
  <input class="search" id="q" placeholder="Search addons…" oninput="filter()">
  <div class="grid" id="grid"><div class="empty">Loading addons…</div></div>
  <div class="note">
    <b>Installing an addon.</b> Click <b>Get</b> to download its <code>.paceaddon</code> file, then in Pace open
    <code>pace://extensions</code> → <b>Install from file</b> and choose it. Addons from the Shop are still
    confirmed with a security prompt the first time, because an addon can read and change the pages you visit.
  </div>
  <script>
    let ALL=[];
    function card(a){
      const dl=(a.downloads||0);
      return '<div class="card"><div class="ic">🧩</div>'+
        '<div class="meta"><div class="nm">'+esc(a.name)+'<span class="pill">v'+esc(a.version)+'</span>'+(dl?'<span class="pill">'+dl+' installs</span>':'')+'</div>'+
        '<div class="by">'+(a.author?('by '+esc(a.author)):'')+'</div>'+
        '<div class="ds">'+esc(a.description||'')+'</div></div>'+
        '<a class="btn" href="/download/'+encodeURIComponent(a.id)+'">Get</a></div>';
    }
    function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    function render(list){
      const g=document.getElementById('grid');
      if(!list.length){ g.innerHTML='<div class="empty">No addons published yet. Be the first — <a href="/publish">publish one</a>.</div>'; return; }
      g.innerHTML=list.map(card).join('');
    }
    function filter(){
      const q=document.getElementById('q').value.toLowerCase().trim();
      render(!q?ALL:ALL.filter(a=>((a.name||'')+' '+(a.description||'')+' '+(a.author||'')).toLowerCase().includes(q)));
    }
    fetch('/api/addons').then(r=>r.json()).then(d=>{ ALL=Array.isArray(d)?d:[]; render(ALL); }).catch(()=>render([]));
  </script>`);
}

function publishPage() {
  return shell('Publish · Pace Addon Shop', `
  <header><div class="logo">⚡</div><h1>Publish an addon</h1></header>
  <div class="sub">Submit a Pace Addon to the Shop.</div>
  <div class="nav"><a href="/">← Back to Shop</a></div>

  <label>Addon ID <span style="opacity:.6">(unique; letters, numbers, - _ .)</span></label>
  <input type="text" id="id" placeholder="my-addon" spellcheck="false">
  <label>Name</label>
  <input type="text" id="name" placeholder="My Addon">
  <label>Version</label>
  <input type="text" id="version" placeholder="1.0.0" value="1.0.0">
  <label>Author</label>
  <input type="text" id="author" placeholder="Your name">
  <label>Description</label>
  <textarea id="description" placeholder="What does it do?"></textarea>
  <label>Package (.paceaddon — a zip of your addon folder)</label>
  <input type="file" id="file" accept=".paceaddon,.zip">
  <label>Publish token</label>
  <input type="password" id="token" placeholder="Your publish token" spellcheck="false">

  <div class="agreement">
    <b>Pace Addon Developer Agreement</b><br>
    By publishing, you confirm that: (1) you have the right to distribute this addon and all its contents;
    (2) it contains no malware, spyware, miners, or code that harms users or their data; (3) it does not
    collect personal data without clear disclosure and consent; (4) it does not impersonate other addons,
    brands, or Pace itself; (5) it complies with applicable law. Addons may be removed at any time if they
    violate these terms. You remain responsible for your addon and any harm it causes. The Shop is provided
    "as is" with no warranty.
  </div>
  <label class="agree"><input type="checkbox" id="agree"> I have read and accept the Developer Agreement.</label>

  <button class="btn" onclick="submitAddon(this)">Publish addon</button>
  <div id="msg"></div>

  <script>
    async function submitAddon(btn){
      const msg=document.getElementById('msg');
      const f=document.getElementById('file').files[0];
      if(!document.getElementById('agree').checked){ msg.style.color='#ff6066'; msg.textContent='Please accept the Developer Agreement.'; return; }
      if(!f){ msg.style.color='#ff6066'; msg.textContent='Please choose a .paceaddon file.'; return; }
      const fd=new FormData();
      fd.append('id',document.getElementById('id').value);
      fd.append('name',document.getElementById('name').value);
      fd.append('version',document.getElementById('version').value);
      fd.append('author',document.getElementById('author').value);
      fd.append('description',document.getElementById('description').value);
      fd.append('token',document.getElementById('token').value);
      fd.append('agree','on');
      fd.append('file',f);
      btn.disabled=true; const o=btn.textContent; btn.textContent='Publishing…'; msg.style.color='var(--t2)'; msg.textContent='Uploading…';
      try{
        const r=await fetch('/api/publish',{method:'POST',body:fd});
        const d=await r.json();
        if(d.ok){ msg.style.color='#5bd6a0'; msg.textContent='✓ Published “'+d.name+'” v'+d.version+'. It is now live in the Shop.'; }
        else { msg.style.color='#ff6066'; msg.textContent='✗ '+(d.error||'Publish failed.'); }
      }catch(e){ msg.style.color='#ff6066'; msg.textContent='✗ Network error: '+e.message; }
      btn.disabled=false; btn.textContent=o;
    }
  </script>`);
}
