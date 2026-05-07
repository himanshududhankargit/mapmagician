# dpplans-seo

Programmatic SEO landing pages for **dpplans.com**. One static-exported Next.js page per Indian Development Plan region, generated from `data/regions.json`. Each page embeds the live DP overlay (iframe to `dpplans.com/maps?…&embed=1`) and links into the full map app on click.

This folder lives **inside `mapmagician-main/`** so the same GitHub repo (`himanshududhankargit/mapmagician`) feeds both `mapmagician.in` (root → GitHub Pages) and `dpplans.com` (this `dpplans-seo/out/` → Cloudflare Pages).

## How to deploy (Cloudflare Pages)

The `mapmagician` Cloudflare Pages project must be configured with:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Framework preset | `None` |
| Build command | `cd dpplans-seo && npm install && npm run build` |
| Build output directory | `dpplans-seo/out` |
| Root directory | *(empty)* |
| Env var `NODE_VERSION` | `20` |

After every push to `main`, Cloudflare:
1. Runs `npm install` inside `dpplans-seo/`
2. Runs `next build` (which calls `build:regions` first)
3. Runs `scripts/postbuild-copy.js`, which copies `maps.html`, `manifest.json`, `sw.js`, `AssetsGIS/` from `mapmagician-main/` into `out/`, and writes `out/CNAME` = `dpplans.com`
4. Publishes `dpplans-seo/out/` to dpplans.com

`mapmagician.in` is unaffected — it's served by GitHub Pages from the repo root and doesn't see the `dpplans-seo/` subfolder.

## Local preview

```bash
cd dpplans-seo
npm install
npm run build
cd out && python -m http.server 8765
# open http://localhost:8765/
```

You **must** serve `out/` over HTTP. Opening `out/<slug>/index.html` directly via `file://` will load the page without any CSS/JS because Next.js writes absolute asset paths (`/_next/...`).

## How to add or update regions

The single source of truth is `data/regions.json`, regenerated from two upstream sources:

1. `data/menuGIS.snapshot.json` — a one-time snapshot of Firebase RTDB `menuGIS` (display names, icons, sub-locations, source links).
2. `../data/database/d1.bin` and `d3.bin` — DP tile metadata, sibling files inside `mapmagician-main/`. The build script extracts each region's KML polygons to compute centroid + bounding box.

To pick up the latest data:

```bash
# Refresh the menu snapshot from Firebase RTDB:
curl -sS "https://sodium-hour-256110.firebaseio.com/menuGIS.json" -o data/menuGIS.snapshot.json

# Rebuild regions.json + the static site:
npm run build
```

`scripts/build-regions.js`:
- Cleans display names (strips parentheticals like `(Updated 16/10/2025)`).
- Builds the slug — `pune-dp-plan`, `solapur-dp-plan`, `mahabaleshwar-msrdc-corridor`, etc.
- Computes centroid + bbox per `productPurchaseID` from the d1/d3 KML.
- Computes 5 nearest in-state regions for the "Nearby" sidebar.
- Generates per-region FAQs and feature lists (templated from the region's data).
- Fails the build on duplicate slugs.

## What each region page contains

- `<title>` and `<meta description>` tuned per region.
- H1, summary paragraph, CTA to `https://maps.mapmagician.in/?lat=…&lng=…&zoom=…`.
- Region icon (served straight from `tiles.mapmagician.in/dpplans/0imagesGIS/<icon>.png`).
- **Live mini-map** via iframe to `maps.mapmagician.in/?…&embed=1`. A transparent click-shield over the iframe routes any tap to the full map (without `embed=1`) so the disclaimer + auth flow runs on the canonical map app.
- About paragraph, sub-locations list (linkable to specific lat/lng on the full map), feature bullets, FAQ accordion (with `details/summary`).
- Sidebar with sub-location list and 5 nearest regions.
- JSON-LD graph: `Place` + `BreadcrumbList` + `FAQPage`.
- OpenGraph + Twitter card meta.
- Canonical URL.

## What the homepage contains

- Hero with description and stat row.
- Client-side filter input (filters cards by name, no fuzzy search).
- Region cards grouped by state.
- JSON-LD graph: `WebSite` (with `SearchAction`) + `Organization`.

## Generated automatically

- `app/sitemap.ts` → `sitemap.xml` listing home + every region page.
- `app/robots.ts` → `robots.txt` referencing the sitemap.

## Tech notes

- Next.js 14 App Router, `output: 'export'`, `trailingSlash: true` so each region is `/<slug>/index.html` (works on any static host without rewrites).
- TypeScript, no client-side data fetching — every page is fully prerendered.
- One `'use client'` component (`MapEmbed`) for the click-shield, plus the homepage filter input. Everything else is a server component.
- No Tailwind, no animation libraries, no UI kit — handwritten CSS in `app/globals.css`.
- All region icons are referenced by absolute URL from CloudFront, so we don't duplicate assets in this repo.

## File map

```
app/
  layout.tsx          root layout, default metadata
  page.tsx            homepage
  [slug]/page.tsx     dynamic region page (generateStaticParams from regions.json)
  not-found.tsx       custom 404
  sitemap.ts          sitemap.xml generator
  robots.ts           robots.txt generator
  globals.css         all styles
components/           SiteHeader, SiteFooter, RegionCard, RegionSearch, Breadcrumbs, Faq, JsonLd, MapEmbed
lib/
  site.ts             SITE constants + Region types
  regions.ts          accessors over data/regions.json
data/
  menuGIS.snapshot.json   committed snapshot of Firebase menuGIS
  regions.json            generated by scripts/build-regions.js
scripts/
  build-regions.js    builds regions.json
```
