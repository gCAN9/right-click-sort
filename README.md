# Right-Click-Sort

Paste an OpenSea URL, get every NFT image from it, and arrange them freely in a
grid for presentation — then save the result as a PNG.

## Run

```
node server.js
```

Then open http://localhost:3000. No dependencies (Node 18+).

## Use

1. Search a profile (exact OpenSea username, ENS name, or 0x address) and
   pick it from the dropdown. The wallet's NFT collections load across all
   supported chains (Ethereum, Base, Robinhood Chain, Shape — resolved
   on-chain via public Blockscout indexers) with a progress
   bar; type in the filter field to find a collection, or paste an OpenSea
   collection URL to locate one whose contract has no on-chain name. Picking
   a collection loads the wallet's held items into the grid.

   (The `/api/nfts?url=…` endpoint for OpenSea collection/item/profile URLs
   still exists for direct use, but is no longer part of the UI.)
2. Arrange:
   - **Canvas** — set the output size in px in the toolbar.
   - **Resize** — drag the corner handle of any image; proportions are
     preserved and the rest of the grid reflows around it.
   - **Reorder** — drag an image to a new position.
   - **Padding** — slider adjusts the gap between images.
   - **Remove** — × button in an image's top-right corner.
3. **Save as picture** exports the canvas as a 2× PNG (`nft-grid.png`).

## Deploy

### Vercel (recommended — no idle spin-down)

Static files ship from Vercel's CDN and `api/nfts.js` / `api/img.js` run as
serverless functions (shared logic lives in `lib/opensea.js`):

1. Sign in at [vercel.com](https://vercel.com) (GitHub login works).
2. **Add New → Project**, import this repository, keep the defaults
   (no framework, no build command), deploy.
3. The app is live at `https://right-click-sort.vercel.app` (or similar).
   Optionally set `OPENSEA_API_KEY` under Settings → Environment Variables
   for more reliable collection fetching.

### Render.com (alternative)

A `render.yaml` blueprint is included: **New → Blueprint**, pick this repo.
Note that Render's free tier spins down when idle (first request after a
quiet period takes ~30–60 s); Vercel does not.

## Limit alerts

When an upstream service rate-limits or fails (OpenSea API, Blockscout
indexers, image hosts), page users see a dismissible banner warning that
results may be incomplete. To ALSO get notified as the operator, set either
(or both) env vars on the deployment:

- `ALERT_WEBHOOK_URL` — any JSON webhook; a Discord channel webhook works
  as-is (Server Settings → Integrations → Webhooks → copy URL).
- `ALERT_NTFY_TOPIC` — a secret topic name of your choosing on
  [ntfy.sh](https://ntfy.sh) (no account needed); subscribe to that topic in
  the ntfy mobile/web app to receive pushes.

Alerts are debounced to one per source per 10 minutes. Vercel-level platform
limits (bandwidth, function hours) are emailed by Vercel itself.

## Notes

- Images are fetched through a local proxy (`/api/img`) so the export canvas
  stays un-tainted by cross-origin data.
- NFT extraction scrapes the collection page's hydration data (first ~50
  items). For guaranteed, rate-limit-friendly access, set an API key before
  starting the server:

  ```
  OPENSEA_API_KEY=… node server.js
  ```
