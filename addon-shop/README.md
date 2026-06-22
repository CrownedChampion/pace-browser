# Pace Addon Shop (Cloudflare Worker)

The storefront + publishing backend for Pace Addons. Storage is **Cloudflare R2** (10 GB free —
the largest free option), so there is no separate database to run.

Live URL (once deployed): `https://paceaddonshop.thestripedfox.workers.dev`

## What it does
- `GET /` — storefront: browse/search published addons, **Get** (download) each `.paceaddon`.
- `GET /publish` — developer page: fill in the metadata, accept the agreement, upload a package.
- `GET /api/addons` — JSON catalog.
- `GET /api/addon/:id` — JSON metadata for one addon.
- `GET /download/:id` — download the `.paceaddon` package (counts installs).
- `POST /api/publish` — publish (requires the secret `PUBLISH_TOKEN`).

## One-time setup
```bash
cd addon-shop
npm i -g wrangler           # if you don't have it
wrangler login

# 1) Create the R2 bucket (matches wrangler.toml: pace-addons)
wrangler r2 bucket create pace-addons

# 2) Set the publish token (pick a long random string; keep it private)
wrangler secret put PUBLISH_TOKEN

# 3) Deploy
wrangler deploy
```
That publishes the Worker to `paceaddonshop.<your-subdomain>.workers.dev`.

## Publishing an addon
1. Zip your addon **folder** (the one containing `addon.json`) and rename it to `my-addon.paceaddon`.
2. Go to `/publish`, fill in the ID / name / version / author / description, attach the file, paste your
   `PUBLISH_TOKEN`, accept the agreement, and click **Publish**.
3. It appears in the Shop immediately.

> Right now publishing is gated by the single `PUBLISH_TOKEN` (you publish on behalf of developers, or
> share the token with trusted devs). A full developer-account system with sign-in and review is a later
> phase — the storage layout already keeps each addon namespaced under `addons/<id>/` so that can be
> layered on without migrating data.

## Notes
- Package size cap is 10 MB (adjust in `worker.js` if needed).
- The catalog lives at `index.json` in the bucket; each addon also stores `addons/<id>/addon.json`
  and `addons/<id>/<id>.paceaddon`.
