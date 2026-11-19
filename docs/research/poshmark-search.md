# Research Report: Poshmark Search Access and Marketplace Filters

- **Issue:** [#3 — Research Poshmark search access and Marketplace Filters](https://github.com/kt31229/unified-marketplace-search/issues/3)
- **Research Date:** November 2026
- **Target Environment:** $0/month local personal desktop execution on Windows (`unified-marketplace-search`)
- **Vocabulary & Evidence Standard:** This report uses canonical domain terms (**Marketplace**, **Listing**, **Unified Filter**, **Marketplace Filter**, **Saved Search**, **Watchlist**). Claims are explicitly categorized as **Official Primary Documentation**, **Community / Open-Source Observation**, or **Unverified / Conflicting Detail**.

---

## Executive Summary & Recommended $0/Month Architecture

Poshmark offers **no official public search or developer API** (free or paid), no official RSS feeds, and explicitly prohibits automated scraping in its Terms of Service (`https://poshmark.com/terms`). For personal, low-volume, on-demand **Saved Search** execution on Windows at **$0/month**, three technical options exist:

1. **Local Windows Browser Automation (Playwright + Chromium, headed or stealth-patched) [Recommended Primary Path]:** Launch local Chromium from Windows on the user's residential IP, navigate to `https://poshmark.com/search?...` (with full **Marketplace Filters** encoded in the URL or applied via UI), and **intercept the live XHR JSON responses** from Poshmark's internal endpoint (`https://poshmark.com/vm-rest/posts`) or read `window.__INITIAL_STATE__`. This avoids brittle DOM scraping, supports full faceted **Marketplace Filters** that direct `/vm-rest/posts` calls often drop, bypasses basic TLS-fingerprinting `403` blocks, and lets the user resolve an occasional CAPTCHA in a visible window.
2. **Direct HTTP to Unofficial JSON Endpoint (`https://poshmark.com/vm-rest/posts`) [Secondary / Fast-Path Candidate]:** Works unauthenticated at conservative rates ($\le 1\text{ req/s}$) when paired with browser-like TLS fingerprints (e.g., `curl_cffi`) and headers. However, community findings warn that direct `request` JSON payloads frequently **ignore deep facet Marketplace Filters** (`brand[]`, `size[]`, `color[]`, `availability`), making it reliable primarily for broad keyword queries plus client-side filtering unless the exact web-generated `filters` payload and `pm_version` headers are replicated.
3. **Direct HTTP to Server-Rendered Browse HTML (`window.__INITIAL_STATE__`) [Fallback for Brand/Category Browse]:** Brand (`/brand/...`) and category (`/category/...`) pages are permitted in `robots.txt` and embed 48 full **Listing** objects inside `window.__INITIAL_STATE__` plus a JSON-LD `ItemList`, usable via TLS-impersonating HTTP clients—though not suitable for arbitrary free-text **Saved Searches** without client-side filtering.

---

## 1. Official APIs, Policies, and `robots.txt`

| Aspect | Finding | Evidence Tier | Reference |
| :--- | :--- | :--- | :--- |
| **Public Search / Developer API** | **None.** Poshmark has no developer portal, API keys, or public search API. Seller management is restricted to in-app *Poshmark Community Toolkit* / CSV Bulk Upload Templates. | Official Primary | [Poshmark Bulk Upload Templates](https://support.poshmark.com/s/article/How-to-use-Bulk-Upload-Templates?language=en_US) |
| **Affiliate / Partner Feeds** | Affiliate programs run through third-party networks (e.g., CJ Affiliate, regional partners) and an internal influencer *Posh Affiliates* program; not a public personal search API. | Official / Secondary | Search verification against `poshmark.com` & affiliate networks |
| **Official RSS Feeds** | **None.** No public RSS feeds exist for searches or closets. | Secondary | Community verification |
| **Terms of Service (ToS)** | Explicitly forbids automation: users may not *"copy, scrape, harvest, crawl or use any technology, software or automated systems to collect any information or data for the Service;;"*. | Official Primary | [`https://poshmark.com/terms`](https://poshmark.com/terms) |
| **`robots.txt` Directives** | `User-agent: *` disallows `/search`, `/api`, `/listings`, and `/users`; public browse paths such as `/brand/...` and `/category/...` remain allowed. | Primary / Community Inspection | [`https://poshmark.com/robots.txt`](https://poshmark.com/robots.txt) (directives observed via `browser-use.com` inspection) |

---

## 2. $0/Month Local Access Options on Windows

### Option A: Local Playwright / Chromium on Windows (with XHR Interception)
- **Cost:** $0/month (runs locally on Windows using residential IP; no paid proxy or scraping API needed for occasional personal **Saved Searches**).
- **How it works:**
  1. Launch local Chromium via Playwright (`patchright` / `playwright-stealth` or a persistent real browser profile; stock headless Playwright leaks `navigator.webdriver = true` and missing codecs, triggering `403` blocks).
  2. Navigate to `https://poshmark.com/search?query=...` with **Marketplace Filter** query parameters (or interact with sidebar facets).
  3. Capture structured **Listing** JSON directly via Playwright `page.on("response", ...)` filtering for `/vm-rest/posts`, or evaluate `window.__INITIAL_STATE__` in page context—eliminating fragile CSS selector parsing for card fields.
- **Pros:** Preserves 100% of **Marketplace Filters**, authentic Chromium TLS/JA3/JA4 + JS execution, interactive human CAPTCHA recovery if ever challenged in headed mode.
- **Cons:** Higher RAM/CPU (~150–400 MB per browser context) and ~2–5 s cold-start latency vs. direct HTTP.

### Option B: Unofficial Internal XHR JSON Endpoint (`/vm-rest/posts`)
- **Endpoint:** `GET https://poshmark.com/vm-rest/posts?request=<URL-encoded-JSON>`
- **Access & Headers:** Publicly callable without user login cookies at low velocity ($\le 1\text{ req/s}$), though plain `fetch`/`requests` often encounter `403 Forbidden` due to TLS fingerprinting; TLS-impersonating clients (Python `curl_cffi`, Rust/Node equivalents) and standard browser headers (`User-Agent`, `Accept: application/json, text/plain, */*`, `Referer: https://poshmark.com/search`, `X-Requested-With: XMLHttpRequest`, and `pm_version`) improve reliability.
- **Verified Minimum `request` JSON Envelope (from `browse.sh` specification):**
  ```json
  {
    "query": "madewell jeans",
    "count": 48,
    "experience": "all",
    "sort_by": "price_asc"
  }
  ```
  - **Strict Type Rule:** `count` and numeric fields **must** be JSON integers (`48`), not strings (`"48"`), or the backend returns `400 ValidationError` (`browse.sh`).
- **Critical Limitation (Facet Filtering):** According to `browse.sh` field testing, passing deep **Marketplace Filters** (`brand[]`, `color[]`, `size[]`, `department`, `category`, `availability`) directly inside the `/vm-rest/posts` `request` JSON is **frequently ignored silently** by the endpoint (`selected_catalog: {}`), returning unfiltered keyword **Listings**. Full strict faceting is enforced by the Vue web app via `/search?...` state or internal `filters` payloads whose exact structure can shift with `pm_version`.

### Option C: Direct HTTP to Server-Rendered HTML (`window.__INITIAL_STATE__`)
- **Mechanism:** Poshmark server-renders initial **Listing** payloads (48 **Listings** per page) inside an embedded `<script>` variable `window.__INITIAL_STATE__` plus a Schema.org JSON-LD `ItemList` (containing 48 canonical **Listing** URLs) on `/brand/...`, `/category/...`, and web browse routes (`browser-use.com`, GitHub scrapers).
- **Trade-off:** Low overhead if fetched with `curl_cffi`, but `/search` is disallowed in `robots.txt` and faces stricter anti-bot scrutiny than `/brand/` or `/category/` routes.

### Comparison Summary for Personal Windows Desktop Use

| Criterion | Local Playwright + XHR Intercept | Direct HTTP (`/vm-rest/posts`) | Direct HTTP (SSR HTML) |
| :--- | :--- | :--- | :--- |
| **Monthly Cost** | **$0/month** | **$0/month** | **$0/month** |
| **Strict Marketplace Filters** | **Full** (web `/search` state) | **Partial / Unreliable** (facets often ignored) | **Good** on `/brand`/`/category`; tighter on `/search` |
| **Anti-Bot / TLS Resilience** | **High** (real Chromium + residential IP; stealth/headed recommended) | **Medium–Low** (requires TLS spoofing + `pm_version` tracking) | **Medium** (`curl_cffi` needed to avoid `403`) |
| **Speed per Query** | ~2–6 s | <1 s | ~1–2 s |
| **Maintenance Risk** | Moderate (UI route / XHR schema drift) | High (undocumented `request` JSON & `pm_version` breaks) | Moderate (`__INITIAL_STATE__` path changes) |

---

## 3. Anti-Bot Protections, Login Barriers, and Stability Risks

### Anti-Bot Infrastructure
- **Cequence Security (Unified API Protection / UAP) [Official Primary Evidence]:** Poshmark publicly partnered with Cequence Security to detect and mitigate automated bot traffic, credential stuffing, and API abuse across both web and mobile endpoints ([Cequence Poshmark Case Study](https://www.cequence.ai/case-study/poshmark-prevents-automated-attacks-with-cequence/)).
- **Network & Behavioral Defenses [Community Evidence]:**
  - **TLS / JA3 / JA4 Fingerprinting & Datacenter ASN Blocking:** Standard scripting clients (`requests`, stock `fetch`) and cloud/datacenter IP ranges frequently hit immediate `403 Forbidden` responses. Running locally from a Windows home residential IP largely avoids ASN blocks.
  - **Headless Browser Detection:** Default headless Playwright (`navigator.webdriver = true`, headless WebGL/codec mismatches) triggers `403` or interactive challenges; stealth patches (`patchright`, `playwright-stealth`) or headed Chromium mitigate this.
  - **Velocity Rate Limiting & CAPTCHAs:** Rapid pagination or automated polling trips CAPTCHAs or temporary blocks. Staying well below ~1 req/s and executing **Saved Searches** strictly on demand minimizes trigger risk.

### Login Barriers
- **Guest Access:** Unauthenticated guests can query `/vm-rest/posts`, `/search`, `/brand/...`, and `/category/...` at low personal request rates without logging in (demonstrated by keyless tools like `pipeworx-io/mcp-poshmark-comps` and `browse.sh`).
- **Authenticated Account Risk:** Logging into a personal Poshmark account for automated scraping is **strongly discouraged**; Poshmark's ToS prohibits automated collection, and behavioral flags on logged-in accounts trigger CAPTCHAs, temporary action throttles ("share jail"), or permanent account suspension.
- **Unverified Detail:** Whether Poshmark currently enforces a specific guest pagination wall or "Sign up to continue" modal after $N$ pages on `poshmark.com/search` in live November 2026 desktop Chromium sessions was not directly verified via live browser execution.

### Maintenance & Stability Risks
1. **Undocumented Schema & Header Churn:** `/vm-rest/posts` and `window.__INITIAL_STATE__` are internal contracts; changes to `pm_version`, `filters` JSON structure, or response key names can silently drop **Unified Filters** or break parsing.
2. **Anti-Bot Rule Tightening:** Cequence / edge rules can invalidate TLS-impersonating HTTP clients without notice, requiring fallback to real local Chromium.
3. **Policy Exposure:** Personal on-demand use avoids commercial redistribution, but remains technically contrary to `poshmark.com/terms` and `/search` `robots.txt` rules.

---

## 4. Supported Marketplace Filters

All **Marketplace Filters** below are synthesized from Poshmark official Help Center taxonomy documentation and community inspection of `poshmark.com/search` query strings and `/vm-rest/posts`. **Unverified items** (requiring one live Chrome DevTools inspection during implementation) are flagged explicitly.

| Unified Filter | Marketplace Filter Support | Observed Web URL (`/search?...`) Syntax | `/vm-rest/posts` & Notes |
| :--- | :--- | :--- | :--- |
| **Keywords** | **Yes** | `query=<url_encoded_text>` | Matches title, description, and brand (`browse.sh`). Native boolean `OR` / advanced query operators are generally treated literally or unreliable. |
| **Price Range** | **Yes** | `price[]=25-50`, `price[]=50-`, `price[]=-50` (repeatable) | API wrappers also document integer bounds (`min_price`/`max_price` or `price_min`/`price_max`), though direct `/vm-rest/posts` facet filtering may be ignored. |
| **Condition** | **Coarse / Partial** | `condition=closet_nwt` (for New With Tags) | **Important Unified Filter Gap:** Official Poshmark condition taxonomy ([Bulk Upload Templates](https://support.poshmark.com/s/article/How-to-use-Bulk-Upload-Templates?language=en_US)) only formally distinguishes **New With Tags (`NWT`)**, **Boutique**, and **Pre-owned** (blank). There is **no official `Like New` / `Good` / `Fair` Marketplace Filter**—those must be approximated via keyword matching or left unmapped. |
| **Size Taxonomy** | **Yes (Department-Scoped)** | `size[]=US%208`, `size[]=Medium`, `size[]=28`, `size[]=OS` (repeatable) | Scoped by `department` + `category`. Official ranges ([Poshmark Sizing Guide](https://support.poshmark.com/s/article/How-does-sizing-work-on-Poshmark)): numeric `00–32`, letter `XXS–5X`, denim `23–33`, shoes, `OS` (One Size). Seller **custom sizes** may not match standard size filters. |
| **Location / Radius** | **No** | *Not supported* | Poshmark supports **no ZIP, city, radius, or local pickup filter**. US (`poshmark.com`) and Canada (`poshmark.ca`) are isolated national **Marketplaces** using postal shipping only; local pickup violates policy. UK, Australia, and India **Marketplaces** closed Oct 26, 2023. |
| **Sort Options** | **Yes** | `sort_by=<value>` | Observed values across web & API sources: `just_in` / `added_desc` (*Just In*), `just_shared` (*Just Shared*), `price_asc` (*Price Low–High*), `price_desc` (*Price High–Low*), `relevance` / `relevance_v2` / `best_match` (*Relevance*), `like_count` / `likes` (*Most Liked*), `price_drop` (*Price Drop*). *Exact active string for Relevance & Just In varies by route—verify in DevTools.* |
| **Pagination** | **Yes (Cursor, Capped)** | `?max_id=<cursor_or_int>` | **48 Listings per page** (`count: 48`). Browse SSR pages use integer/cursor `?max_id=N`; `/vm-rest/posts` uses base64 `ENC_...` cursor from `more.next_max_id`. Hard depth cap reported around **~5,000 Listings (~105 pages)**. |
| **Department / Category** | **Yes** | `department=Women`, `category=Jeans`, `sub_category=Mini` | Official top-level `department` values include `Women`, `Men`, `Kids`, `Home`, `Electronics` (plus Pets on web UI; verify exact slug). |
| **Brand & Color** | **Yes** | `brand[]=Madewell`, `color[]=Black` | Repeatable array query params on `/search` or `/brand/...`. |
| **Availability** | **Yes** | `availability=available`, `sold_out`, `all` | Maps to `status` (`available`, `sold_out`, `all`) in some API wrappers; critical for filtering out sold **Listings** or querying sold comps. |
| **Shipping Discount** | **Yes (Partial)** | `shipping_discount` (exact enum unverified) | Web sidebar supports filtering for discounted/free shipping offers; exact URL parameter values should be verified via DevTools. |

---

## 5. Returned Listing Fields

When reading Poshmark's underlying JSON (via intercepted `/vm-rest/posts` responses or `window.__INITIAL_STATE__`), the following fields map to our canonical **Listing** schema.

> **Schema Caveat (Community vs. Raw Payload Variations):** Community documentation (`browse.sh`, `browser-use.com`, `explainx.ai`, `reefapi.com`, `compsniper.com`) shows minor key naming differences depending on whether the payload is raw `/vm-rest/posts`, SSR `window.__INITIAL_STATE__`, or a normalized wrapper (e.g., `price_amount` vs `price`, `cover_shot` vs `picture_url`). Exact JSON paths must be confirmed once via Chrome DevTools against a live response.

| Canonical Listing Field | Observed Raw Poshmark JSON / SSR Field(s) | Format & Notes | Evidence Tier |
| :--- | :--- | :--- | :--- |
| **Title** | `title` | Plain text string of the **Listing** title. | Community / Open-Source |
| **Price** | `price_amount.val` + `price_amount.currency_code` (and/or `price.val`, `original_price_amount`) | Exact decimal string or number (e.g., `"24.50"`, `"USD"`) plus seller's original retail MSRP (`original_price_amount`). Also carries display-formatted variants in some payloads. | Community / Open-Source |
| **Shipping** | Base rate fixed by policy + `shipping_discount` JSON field | **Standard US Shipping (Official Primary):** **$6.49** flat-rate buyer-paid via **USPS Ground Advantage** (2–5 business days, up to 5 lbs), effective September 12, 2025, replacing $8.27 USPS Priority Mail ([Poshmark Shipping Rates Art. 000004198](https://support.poshmark.com/s/article/000004198)). Per-**Listing** seller/promo discounts appear in `shipping_discount` (`null` when standard $6.49 applies). | Official Primary + Community |
| **Thumbnail** | `cover_shot.url` / `url_small` / `url_large` / `url_webp` (or `picture_url`) | Absolute CloudFront CDN image URL (`https://di2ponv0v5otw.cloudfront.net/...`). Full gallery array (`pictures` / `images`) holds up to 16 photos. | Community / Open-Source |
| **Direct URL** | `canonical_url` (where exposed) or constructed `https://poshmark.com/listing/<slug>-<id>` | Also directly extracted from SSR `<script type="application/ld+json">` `ItemList` on brand/category pages. | Community / Open-Source |
| **Availability Status** | `inventory.status` or `status` | Observed values: `"available"`, `"sold_out"` / `"sold"`, `"reserved"`, `"not_for_sale"`. | Community / Open-Source |
| **Helpful Extra Fields** | `id`, `brand`, `size`, `condition`, `colors`, `department` / `category`, `seller.username`, `engagement_statistics.likes`, `description` | Useful for client-side filtering (especially condition/wear keywords when `condition` is blank/pre-owned) and **Watchlist** snapshots. | Community / Open-Source |

---

## 6. Open Verification Checklist (For Implementation Kickoff)

Before writing the Poshmark adapter, run **one manual Chrome DevTools session** on Windows against `https://poshmark.com/search` (not logged in) to lock down the remaining unverified details:
1. **Exact `sort_by`, `condition`, and `shipping` URL query params** emitted by the 2026 Poshmark web UI (e.g., `just_in` vs `added_desc`, `best_match` vs `relevance_v2`, `condition=closet_nwt`, `shipping_discount` enum).
2. **Exact `/vm-rest/posts` XHR `request` JSON `filters` sub-object and `pm_version` header** sent by the Vue frontend when applying multi-facet **Marketplace Filters**.
3. **Exact raw JSON keys** on one live **Listing** object in `/vm-rest/posts` (`price_amount` vs `price`, `cover_shot` vs `picture_url`, `inventory.status` vs `status`, `shipping_discount`).
4. **Guest pagination threshold** in real Chromium on Windows (confirm how many pages paginate cleanly before any login modal or CAPTCHA challenge triggers).

---

## References

### Official Primary References
- Poshmark Terms of Service (scraping/automation prohibition): `https://poshmark.com/terms`
- Poshmark Shipping Rates (USPS Ground Advantage $6.49 flat rate up to 5 lbs): `https://support.poshmark.com/s/article/000004198`
- Poshmark USPS Ground Advantage Packaging Supplies: `https://support.poshmark.com/s/article/000004523`
- Poshmark Overweight Shipping Labels: `https://support.poshmark.com/s/article/000004277`
- Poshmark Sizing Guide (`00–32`, `XXS–5X`, `23–33`, custom sizes): `https://support.poshmark.com/s/article/How-does-sizing-work-on-Poshmark`
- Poshmark Bulk Upload Templates (Condition taxonomy / NWT / Boutique): `https://support.poshmark.com/s/article/How-to-use-Bulk-Upload-Templates?language=en_US`
- Poshmark Support FAQs: `https://support.poshmark.com/s/article/FAQs`
- Poshmark `robots.txt`: `https://poshmark.com/robots.txt`
- Cequence Security Case Study (*Poshmark Prevents Automated Attacks with Cequence*): `https://www.cequence.ai/case-study/poshmark-prevents-automated-attacks-with-cequence/`

### Secondary & Open-Source References
- Value Added Resource (Sept 12, 2025 USPS Ground Advantage $6.49 transition): `https://valueaddedresource.net/poshmark-strikes-usps-contract-deal-will-switch-shipments-to-ground-advantage-for-lower-rates/`
- Pipeworx MCP Server for Poshmark Comps (keyless public search/comp extraction): `https://github.com/pipeworx-io/mcp-poshmark-comps` (NPM/MCP gateway: `https://gateway.pipeworx.io/poshmark-comps/mcp`)
- GitHub Poshmark Product Scraping Topic: `https://github.com/topics/poshmark-product-scraping`
- `browse.sh` Catalog Poshmark Search Skill (`browse skills add poshmark.com/search-listings-vrg59r` — documents `/vm-rest/posts`, `request` JSON strict types, `ENC_...` `max_id`, silent facet-ignore caveat): `https://browse.sh/` *(Note: exact deep skill URL obscured by search-grounding redirect)*
- Additional technical observations synthesized via web search from `browser-use.com` (`window.__INITIAL_STATE__`, `robots.txt` audit, `?max_id=N`, ~5,000 / 105-page cap), `cotera.co`, `explainx.ai`, `reefapi.com`, `compsniper.com`, `apify.com`, `supplychaindive.com`, and `techcrunch.com` *(exact deep URLs behind search-grounding redirects; treat schema/parameter details from these sources as secondary until confirmed in DevTools)*.
