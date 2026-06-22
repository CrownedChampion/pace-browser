# Pace Addon Shop

A Cloudflare Worker storefront for **Pace Addons**, with files stored in **Backblaze B2**.

- `GET  /`                 storefront (browse + search)
- `GET  /publish`          developer publish form + agreement
- `GET  /api/addons`       catalog JSON
- `GET  /api/addon/:id`    one addon's metadata
- `GET  /download/:id`     downloads the `.paceaddon` (and counts the install)
- `POST /api/publish`      publish (gated by the `PUBLISH_TOKEN` secret)

Storage layout in the bucket: `index.json` (catalog), `addons/<id>/addon.json`, `addons/<id>/<id>.paceaddon`.

---

## One-time setup

### 1. Create the Backblaze bucket
- Backblaze account → **B2 Cloud Storage** → **Buckets** → **Create a Bucket**.
- Name it (e.g. `pace-addons`). Files are private; the Worker reads them with its key, so **Private** is fine.
- After it's created, note the **Bucket ID** shown on the bucket's row.

### 2. Put the bucket name in `wrangler.toml`
Edit `[vars] B2_BUCKET_NAME` to match the name you chose.

### 3. Install + log in to Wrangler
```bash
npm i -g wrangler
wrangler login
```

### 4. Set the secrets (these never touch git)
```bash
wrangler secret put B2_KEY_ID       # your Backblaze keyID
wrangler secret put B2_APP_KEY      # your Backblaze applicationKey
wrangler secret put B2_BUCKET_ID    # the Bucket ID from step 1
wrangler secret put PUBLISH_TOKEN   # any long random string you invent
```

Your key (already created, named `Pace-Extensions`):
- keyID: `005256fcc90c0eb0000000001`
- applicationKey: `K005q6mEMD8STLTzs3NFERX3qypiAiI`

> The application key must have **read + write** access to the bucket. The default
> "master" application key works; if you made a restricted key, scope it to this bucket.

### 5. Deploy
```bash
cd addon-shop
wrangler deploy
```
It deploys to `https://paceaddonshop.<your-subdomain>.workers.dev`, which is what the browser's
**Pace Addon Shop** button already opens.

---

## Publishing an addon
From the `/publish` page, or with curl:
```bash
curl -X POST https://paceaddonshop.<sub>.workers.dev/api/publish \
  -H "Authorization: Bearer YOUR_PUBLISH_TOKEN" \
  -F "package=@my-addon.paceaddon"
```
The `.paceaddon` is just a zip of the addon folder (the one containing `addon.json`).

## How the B2 integration works
- The Worker authorizes once (`b2_authorize_account`) and caches the token at module scope (~24h).
- Reads fetch `…/file/<bucket>/<name>` with that token, so the bucket stays private.
- Writes use `b2_get_upload_url` → upload, with an `X-Bz-Content-Sha1` computed via Web Crypto.
- No S3 request-signing (SigV4) is involved, so there's nothing fiddly to maintain.

## Notes
- B2 free tier: 10 GB storage + generous free egress — plenty for an addon catalog.
- B2 keeps old file versions on overwrite. If `index.json` versions pile up over time, add a
  bucket **Lifecycle rule** ("keep only the last version") in the Backblaze UI.
