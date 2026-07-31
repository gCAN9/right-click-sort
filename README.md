# Right-Click-Sort

Paste an OpenSea URL, get every NFT image from it, and arrange them freely in a
grid for presentation — then save the result as a PNG.

## Run

```
node server.js
```

Then open http://localhost:3000. No dependencies (Node 18+).

## Use

1. Paste an OpenSea URL and press Enter. Supported:
   - Collection: `opensea.io/collection/{slug}`
   - Single item: `opensea.io/assets/{chain}/{contract}/{tokenId}`
   - Profile / filtered profile view:
     `opensea.io/{user}?addresses=0x…,0x…&collectionSlugs=slug1,slug2`
     (wallet holdings are resolved on-chain via public Blockscout indexers, so
     it works even for wallet filters OpenSea only shows when logged in; with
     no `addresses` param the profile's public wallet is used)
2. Arrange:
   - **Canvas** — set the output size in px in the toolbar.
   - **Resize** — drag the corner handle of any image; proportions are
     preserved and the rest of the grid reflows around it.
   - **Reorder** — drag an image to a new position.
   - **Padding** — slider adjusts the gap between images.
   - **Remove** — × button in an image's top-right corner.
3. **Save as picture** exports the canvas as a 2× PNG (`nft-grid.png`).

## Deploy (Render.com, free)

The repo contains a `render.yaml` blueprint:

1. Sign in at [render.com](https://render.com) (GitHub login works).
2. **New → Blueprint**, pick this repository, accept the defaults.
3. Render builds and serves the app at `https://right-click-sort.onrender.com`
   (or similar). Optionally set `OPENSEA_API_KEY` in the service's environment
   for more reliable collection fetching.

Notes for the free tier: the instance spins down when idle, so the first
request after a quiet period takes ~30–60 s to wake up.

## Notes

- Images are fetched through a local proxy (`/api/img`) so the export canvas
  stays un-tainted by cross-origin data.
- NFT extraction scrapes the collection page's hydration data (first ~50
  items). For guaranteed, rate-limit-friendly access, set an API key before
  starting the server:

  ```
  OPENSEA_API_KEY=… node server.js
  ```
