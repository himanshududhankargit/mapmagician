# Layer metadata files

These files are plain JSON despite the `.bin` extension. The rename is a
lightweight obscurity measure so the DevTools Network tab and casual `curl`
attempts don't spell out the dataset name. They are **not encrypted** —
anyone who downloads one and opens it in a text editor sees readable JSON.

| File     | Was                    | Contains |
|----------|------------------------|----------|
| `d1.bin` | `MahaGIS.json`         | Maharashtra DP (Development Plan) layer metadata — per-district tile URL paths, KML polygon boundaries, productPurchaseIDs, min/max zoom. |
| `d2.bin` | `MahaVillage.json`     | Maharashtra village layer metadata — same schema, scoped to villages. |
| `d3.bin` | `oldDPPlanGIS.json`    | Old/legacy DP layer metadata — polygons for regions where old development plans are available. |

Served at `https://www.mapmagician.in/data/database/{d1,d2,d3}.bin` and
fetched by `maps2.html` via `getCachedOrFetchLayer`. Responses are cached
in `localStorage` under keys `layer_dp`, `layer_village`, `layer_olddp`
with a `{v, d}` envelope where `v` matches `appConfig/dataVersions/layer_*`
in Firebase RTDB.

## Update workflow

1. Overwrite the `.bin` file in this folder. The source of truth lives at
   `D:\Dropbox\Office\*.json` on the author's desktop; on copy-in, rename
   the extension from `.json` to `.bin`.
2. `git add` + `git commit` + `git push` from `mapmagician-main/`.
3. Open the Android admin panel → App Config → **Web Cache Versions** →
   tap the Bump button for the layer you updated. This writes a new
   timestamp to `appConfig/dataVersions/{layer_dp|layer_village|layer_olddp}`
   in Firebase RTDB. Every open `maps2.html` tab detects the change via
   its live listener, evicts its localStorage cache for that layer, and
   refetches the new `.bin` within ~1s.

## Why `.bin` instead of `.json`

GitHub Pages serves these as `application/octet-stream` by default, which
means DevTools shows them as binary blobs rather than pretty-printed JSON.
A determined scraper can still read the JS source of `maps2.html`, find
the URL, and download them — this is deterrence, not protection. The
actual content gate for tile imagery is the CloudFront signed-cookie
policy on `tiles.mapmagician.in/*`.
