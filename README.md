# Unified Marketplace Search

A local-first personal search aggregator for Windows (`127.0.0.1`) that queries **eBay**, **Poshmark**, **Mercari US**, and **Facebook Marketplace** on demand and merges **Listings** into one workbench.

## Prerequisites

- **Node.js 24+** (`npm`)
- Google Chrome (default) or Microsoft Edge installed locally for browser-backed **Marketplaces**

## Quickstart

Install dependencies and build the production bundle:

```cmd
npm ci
npm run build
```

### Start the App

- **Double-click `start-ums.cmd`** (or run `start-ums.cmd` from the repository root): builds `dist/` if missing, starts the server on `http://127.0.0.1:4173` (`UMS_PORT` override) if not already running, waits for `/api/health`, and opens the URL in your default browser. If an instance is already bound to that port, it opens the existing URL and exits cleanly without spawning a duplicate server.
- **CLI start**: `npm start` (or `npm start -- --open` to also launch your default browser).

### Tests & Verification

```cmd
npm test
npm run typecheck
npm run build
```

`npm test` runs Vitest completely offline without launching real Chrome or making external network requests.

### Manual Opt-In Live Smoke Check

To run a single paced diagnostic check against live **Marketplaces** (excluded from `npm test` and CI):

```cmd
npm run smoke:live
```

Optional flags:

```cmd
npm run smoke:live -- --query="patagonia jacket" --marketplaces=ebay,poshmark,mercari,facebook
```
