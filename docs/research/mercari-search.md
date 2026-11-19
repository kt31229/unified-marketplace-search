# Research: Mercari (US) Search Access and Marketplace Filters

**Issue:** [#4 — Research Mercari search access and Marketplace Filters](https://github.com/kt31229/unified-marketplace-search/issues/4)  
**Research Date:** November 2026  
**Scope:** \$0/month on-demand personal local search on Windows targeting Mercari US (`https://www.mercari.com/`)

---

## Executive Summary

1. **No official public API exists for Mercari US (`www.mercari.com`).** Mercari US provides no self-service developer API, RSS feed, or affiliate catalog feed for querying Listings. Official APIs are limited to private enterprise partnerships (shipping/payment integrations) and **Mercari Shops** in Japan (`https://api.mercari-shops.com/v1/graphql`), which requires a business merchant contract and does not index US consumer Listings.
2. **Terms of Service prohibit automation.** Mercari US Terms of Service (`https://www.mercari.com/tos/`) and Prohibited Conduct policy (`https://www.mercari.com/us/help_center/article/339/`) explicitly forbid automated scraping, crawlers, or bots.
3. **Plain HTTP and cookieless API calls fail immediately.** `https://www.mercari.com/search/` is a Next.js single-page application protected by Cloudflare WAF/Bot Management (`cf-ray`, `__cf_bm`, `cf_clearance`, Turnstile challenges). Direct `curl` or Python `requests` calls return `403 Forbidden` (Cloudflare challenge) or `401 Unauthorized` on the internal GraphQL endpoint (`https://www.mercari.com/v1/api`).
4. **Only viable \$0/month local approach on Windows: stealth local browser automation + network interception.** Navigating `https://www.mercari.com/search/?...` in a local Windows Chromium/Chrome instance (e.g., patched/stealth Playwright such as `patchright-python` or direct CDP drivers like `nodriver` on a residential IP) and intercepting the client-triggered `searchFacetQuery` XHR/Fetch responses avoids brittle CSS scraping and avoids re-implementing Cloudflare clearance, session cookies, and rotating persisted-query hashes (`sha256Hash`).
5. **Marketplace Filter & Listing coverage is strong with key caveats:** Keywords, price bounds, condition (5 tiers), availability status (For Sale vs. Sold), shipping payer, category, brand, size, color, and sort order are exposed via URL parameters on `/search/`. **Location/radius filtering is no longer available** because Mercari Local was abruptly discontinued in November 2024. Displayed Listing prices exclude the **3.6% Buyer Protection Fee** (effective January 6, 2025), which is added at checkout.

---

## 1. Official API Availability & Legal / Policy Findings

### 1.1 Mercari US (`www.mercari.com`) vs. Mercari Japan & Mercari Shops

A frequent pitfall in community documentation is conflating three separate Mercari ecosystems:

| Ecosystem | Domain / Endpoint | Official Public Search API? | Relevance to Mercari US Search |
| :--- | :--- | :--- | :--- |
| **Mercari US (Target Marketplace)** | `https://www.mercari.com/` | **No.** Restricted bilateral enterprise partner integrations only (carriers, payment processors); no self-service developer portal, RSS, or affiliate catalog feed (US runs a credit-based Referral Program, not an open affiliate feed network). | Primary target for US Listings. |
| **Mercari Shops (Japan B2C/B2B)** | `https://api.mercari-shops.com/v1/graphql` | **No (Merchant-Gated).** Official GraphQL API exists, but requires a formal merchant contract, IP allowlisting, assigned `User-Agent` Client Name prefix, and shop-dashboard Personal Access Tokens (`設定 > 拡張機能 > APIアクセストークンの発行`). | Not usable for US consumer Listings. |
| **Mercari Japan (C2C)** | `jp.mercari.com` / `api.mercari.jp` | **No.** Popular open-source Python packages (`take-kun/mercapi`, `SteveShin323/carimer-api`) target `api.mercari.jp` and its ES256 DPoP signing. | Does **not** query Mercari US inventory. |

*Confidence: High for absence of public Mercari US API and for Mercari Shops gating (verified via Mercari Shops API references, Mercari US Help Center/ToS grounding, and open-source repository scopes).*

### 1.2 Terms of Service & `robots.txt` (Primary Policy References)

* **Terms of Service (`https://www.mercari.com/tos/`):** Prohibits interfering with or disrupting the Marketplace, explicitly banning *"monitoring, gathering, copying, or distributing the Platform by using any robot, 'bot,' spider, scraper, crawler, spyware, engine, or any other automatic device, utility, or manual process."*
* **Prohibited Conduct (`https://www.mercari.com/us/help_center/article/339/`):** Reinforces restrictions on automated access and excessive infrastructure load. Violations risk IP throttling/blocks, CAPTCHA challenges, or suspension of associated user accounts.
* **`robots.txt` (`https://www.mercari.com/robots.txt`):** Disallows crawler access to account, listing-creation, and transactional routes (such as `/mypage/`, `/sell/`, `/transaction/`, `/favorites/`). Even where public search URLs are not explicitly disallowed in `robots.txt`, Mercari's ToS independently prohibit automated extraction.

---

## 2. Evaluation of \$0/month Local Access Options on Windows

### Option A: Standard HTTP Clients (`curl`, `requests`, `httpx`, Node `fetch`) — **Not Viable**

* **HTML shell (`https://www.mercari.com/search/`):** Community automation documentation (`browse.sh`, `browser-use.com`) reports that direct HTTP requests fail at the edge with `403 Forbidden` and a Cloudflare Managed Challenge (`"Just a moment..."`) due to TLS/JA3/JA4, HTTP/2, and behavioral checks.
* **SSR payload limitation:** Even when HTML loads, `www.mercari.com/search/` is a Next.js SPA shell whose initial HTML `__NEXT_DATA__` contains virtually no search Listing payloads (unlike individual Listing detail URLs `/us/item/<id>/`, where `__NEXT_DATA__.props.pageProps.serverState` often holds serialized Listing details).

### Option B: Direct Internal Endpoint Calls (`/v1/api` + TLS Impersonation) — **Not Recommended / Brittle**

* **Internal endpoint:** Client-side search queries hit `https://www.mercari.com/v1/api` (specifically GraphQL Automatic Persisted Queries via `GET /v1/api?operationName=searchFacetQuery&variables=...` with `extensions.persistedQuery.sha256Hash`).
* **Auth & cookie gate:** Cookieless or scripted requests directly to `www.mercari.com/v1/api` return `401 Unauthorized` (`{"errors":[{"status":401,"message":"Unauthorized"}]}`), as documented in `browse.sh` findings, because the endpoint requires browser-minted session cookies, headers, and valid Cloudflare cookies (`__cf_bm`, `cf_clearance`).
* **DPoP & BFF architecture note:** Mercari engineering blog articles (`engineering.mercari.com`) document OIDC/OAuth **DPoP** (Demonstrating Proof-of-Possession using client-generated NIST P-256 ECDSA key pairs signing per-request JWTs), `X-Platform: web` headers, and gRPC/Connect Protocol BFF architectures. While ES256 DPoP is extensively documented on Mercari Japan (`api.mercari.jp`) and Mercari's engineering blog, exact live wire-level header requirements (e.g., whether `www.mercari.com/v1/api` currently enforces DPoP proof headers alongside session cookies and `sha256Hash` safelists) were **not directly verified via live packet capture** and are flagged for a pre-implementation smoke check.
* **Why TLS impersonation alone (`curl_cffi`) is fragile:** Even if `curl_cffi` matches Chrome TLS fingerprints on a Windows residential IP, it cannot execute Cloudflare Turnstile JavaScript challenges or automatically track rotating Apollo `sha256Hash` strings across frontend deploys.

### Option C: Local Browser Automation on Windows + CDP Interception — **Recommended \$0/month Path**

* **How it works:**
  1. Launch a local Windows browser on the user's residential IP using a stealth/unmodified CDP driver rather than stock headless Playwright (stock Playwright leaks `navigator.webdriver = true`, WebGL/codec anomalies, and often loops on Cloudflare Turnstile). Community tooling highlights **`patchright-python`** (patched Playwright) or **`nodriver`** (direct async CDP without WebDriver), or a persistent headed/minimized Chrome profile.
  2. Navigate directly to the constructed Marketplace search URL (`https://www.mercari.com/search/?keyword=...&...`).
  3. Attach a CDP / `page.on('response')` listener to intercept `searchFacetQuery` JSON responses from `https://www.mercari.com/v1/api` as the page initially hydrates and optionally scrolls.
* **Why interception beats DOM scraping and direct API replay:**
  * The browser natively handles TLS fingerprints, Cloudflare JS checks (`cf_clearance`), session cookie minting, any client-side request signing, and current `sha256Hash` values.
  * Parsing structured JSON from `searchFacetQuery` (`data.search.itemsList`) avoids breakage from React/CSS class name churn.
* **Resource & UX cost on Windows:** Launches a Chromium process (~200–500 MB RAM) on demand when the user executes a search or runs a **Saved Search**; takes ~3–8 seconds per query and costs \$0/month (no proxies or scraping SaaS required for low-volume personal queries).

### Note on Existing Open-Source Clients

* `https://github.com/adamgauthier/mercari-client` (Node.js wrapper for Mercari US) was **archived read-only in mid-2026** and is unmaintained.
* `https://github.com/philipperemy/mercari-python-api`, `https://github.com/take-kun/mercapi`, and `https://github.com/SteveShin323/carimer-api` should not be assumed compatible with Mercari US (`www.mercari.com`) without inspecting their target hosts (the latter two target Mercari Japan `mercari.jp`).

---

## 3. Anti-Bot, Auth, Login Barriers & Stability Risks

| Risk Category | Observed Reality on `www.mercari.com` | Impact on On-Demand Windows Use |
| :--- | :--- | :--- |
| **WAF / Anti-Bot** | **Cloudflare Bot Management & WAF** (`cf-ray` header, `__cf_bm` & `cf_clearance` cookies, Turnstile / Managed Challenges). Datacenter IPs (AWS/GCP/DigitalOcean) are aggressively blocked; DataDome and PerimeterX were not observed in reviewed materials for `www.mercari.com`. | High on headless/datacenter automation; manageable on a local Windows residential IP using stealth/patched browser profiles at low human-like cadence. |
| **Session / Auth Barrier** | `/v1/api` requires browser-minted session cookies (`401 Unauthorized` without them). Community automation skills (`browse.sh`, `browser-use.com`) fetch `searchFacetQuery` via browser navigation without requiring a user login, though other scraping reports warn of mandatory login prompts/redirects on suspicious or deep unauthenticated sessions. | **Partially uncertain:** Verify in a live Windows browser test whether clean unauthenticated browsing hits a sign-in modal after initial load or N scroll batches. Do not log into a personal Mercari account inside an automated profile if avoiding account-ban risk. |
| **Persisted Query Churn** | `searchFacetQuery` relies on Apollo persisted query `sha256Hash` values (server safelisting). | Breaks direct API clients on deploys; **mitigated** by driving `/search/` in a browser and intercepting responses. |
| **Taxonomy Drift** | `categoryIds`, `brandIds`, and `sizeIds` are opaque numeric IDs that change with catalog updates. | Translating **Unified Filters** into numeric Marketplace IDs can silently drift over time. |
| **Turnstile Escalation** | Rapid sequential queries across multiple **Saved Searches** can trigger interactive Cloudflare Turnstile challenges. | Needs rate limiting (sequential execution, cooldowns, persistent browser profile) and graceful UI fallback to let the user complete a Turnstile prompt if surfaced. |

---

## 4. Supported Marketplace Filters (`www.mercari.com/search/`)

Mercari US exposes **Marketplace Filters** directly as URL query parameters on `https://www.mercari.com/search/?...`, which drive the frontend's `searchFacetQuery` calls. Multi-value parameters are typically hyphen-joined (`-`) in current URLs (e.g., `1-2`), though older/third-party builders also reference URL-encoded commas (`%2C`).

| Filter Dimension | URL Query Parameter | Documented Values / Format | Notes, Gaps & Unified Filter Mapping |
| :--- | :--- | :--- | :--- |
| **Keywords** | `keyword` | URL-encoded string (e.g., `keyword=nintendo+switch`) | Direct 1:1 mapping from Unified query text. |
| **Price Range** | `minPrice`, `maxPrice` | Numeric bounds (e.g., `minPrice=10&maxPrice=100`) | **Critical unit uncertainty:** Community URL builders show **whole dollars** (`10` = \$10), whereas `searchFacetQuery` GraphQL variables/payloads have been reported in **cents** (`15000` = \$150.00). **Verify live** before implementing. Filters base Listing price only (excludes the 3.6% Buyer Protection Fee added at checkout). |
| **Condition Taxonomy** | `itemConditions` | Hyphen-separated IDs:<br>`1` = **New** (unused, tags/sealed)<br>`2` = **Like New** (unused, no tags/box)<br>`3` = **Good** (lightly used, minor wear)<br>`4` = **Fair** (noticeable wear/flaws)<br>`5` = **Poor** (heavy wear/damage) | Official condition definitions documented at `https://www.mercari.com/us/help_center/topics/listings/item-conditions/conditions/`. Maps cleanly to a **Unified Filter** condition enum. |
| **Availability Status** | `itemStatuses` | `1` = **For Sale / On Sale**<br>`2-3` (or `2`/`3`) = **Sold / Completed** | Browser-Use traces note the UI normalizes `2` to `2-3` for sold Listings. Default live search should pass `itemStatuses=1`. |
| **Shipping Payer** | `shippingPayerIds` | `1` = **Seller pays** (Free shipping)<br>`2` = **Buyer pays** | Community docs (`apify.com`, `browse.sh`) note `1`/`2` occasionally flip in Mercari JP vs. US wrapper docs; **verify `1` vs. `2` live** on `mercari.com`. |
| **Delivery Method** | `deliveryType` | Internal delivery/carrier method IDs | Exact valid enum IDs were not surfaced in public docs; verify via live capture if needed. |
| **Location / Radius** | *None* | **Unsupported** | **Mercari Local** (Uber/FedEx local delivery) was discontinued in **November 2024**, and local Meetup tests have wound down. Mercari US has no zip-code or mile-radius **Marketplace Filter**; Unified location filters must treat Mercari as nationwide-shipping-only (or omit/warn). |
| **Category** | `categoryIds` | Opaque numeric node IDs (e.g., `categoryIds=702`) | Hierarchical numeric taxonomy; extractable from `mercari.com` category URLs or facet payloads. |
| **Brand** | `brandIds` | Opaque numeric brand IDs | Dynamic catalog IDs. |
| **Size** | `sizeIds` | Opaque numeric size IDs | **Category-dependent:** US apparel/shoe sizes map to distinct numeric IDs per category. Translating a **Unified Filter** for size requires maintaining an internal category-to-`sizeIds` table (high maintenance) or falling back to keyword/post-filtering. |
| **Color** | `colorIds` | Opaque numeric color IDs | Dynamic catalog IDs. |
| **Sort Order** | `sortBy` | `1` = Best Match / Relevance (default)<br>`2` = Newest First<br>`3` = Price: Low to High<br>`4` = Price: High to Low<br>*(Also reported in some contexts: `6` or `4` for Most Liked / Recently Sold; one third-party tool `dealhunter.io` showed `sortBy=created_time`)* | `1`–`4` are consistently cited across `browser-use.com` and `apify.com` US schemas; verify `created_time` vs. numeric IDs and any "Most Liked" code live. |
| **Pagination** | Infinite scroll (`pageToken` / `nextKey` internally) | No URL `page=` parameter on infinite scroll. Client fires subsequent `searchFacetQuery` calls on scroll. | `browser-use.com` notes ~100 Listings per batch and end-of-feed `nextKey: "0"`. Exact batch size, cursor field name, and max scroll/Listing cap are **unverified** without a live trace. |

---

## 5. Returned Listing Fields

When intercepting `searchFacetQuery` responses, Listings reside in the array `data.search.itemsList` (with single-Listing fallback data also serialized in `/us/item/<id>/` `__NEXT_DATA__.props.pageProps.serverState`).

| Target Listing Field | Observed Field / Derivation | Representation & Caveats |
| :--- | :--- | :--- |
| **Title** | `name` | Listing title string. |
| **Price** | `price` | Community GraphQL traces (`github.com`) report `price` in **integer cents** (e.g., `15000` = \$150.00), whereas DOM cards show formatted dollars. **Buyer Protection Fee note:** Since Jan 6, 2025, Mercari US charges buyers a flat **3.6%** Buyer Protection Fee on Listing price + buyer-paid shipping at checkout; this fee is **not** included in the search Listing `price`. |
| **Shipping** | `shippingPayer` (plus shipping metadata if present) | Indicates seller-paid (free shipping) vs. buyer-paid. Whether exact buyer-paid dollar shipping cost is always populated on `itemsList` grid objects or requires fetching the Listing detail page (`/us/item/<id>/`) is **unverified** and should be checked in live capture. |
| **Thumbnail** | `thumbnails` / `photos` | CDN image URLs hosted on `https://u-mercari-images.mercdn.net` (supports query params such as `?width=2560&quality=75`). |
| **Direct URL** | Derived from `id` | Canonical US Listing URL: `https://www.mercari.com/us/item/<id>/` (typically prefixed with `m`, e.g., `m12345678901`). |
| **Availability Status** | `status` | Enum/string such as `on_sale`, `sold_out` (or `stop` / `in_progress` equivalents). |
| **Additional Useful Fields** | `itemCondition`, `brand`, `category`, seller ID | Reported in `itemsList` and Listing detail `__NEXT_DATA__`; useful for post-filtering or displaying Listing condition badges. |

---

## 6. Unverified Details & Recommended Pre-Implementation Checks

Before implementing a Mercari US adapter, run a 5-minute manual inspection in Chrome DevTools on Windows (opening `https://www.mercari.com/search/?keyword=switch` while logged out):

1. **Confirm `minPrice` / `maxPrice` units** in both the browser address bar URL (dollars vs. cents) and the `searchFacetQuery` request variables.
2. **Inspect `https://www.mercari.com/v1/api` request headers** to verify whether `DPoP` headers are present on US `www.mercari.com` traffic or only session cookies + Cloudflare cookies (`cf_clearance`, `__cf_bm`) + APQ `sha256Hash`.
3. **Capture a sample `data.search.itemsList[0]` object** to confirm exact key names for shipping cost (dollars vs. payer-only flag), `price` unit (cents vs. dollars), `thumbnails`/`photos` array shape, and pagination cursor (`pageToken` / `nextKey`, batch size, and max depth).
4. **Verify `sortBy` values (`1`–`4` vs. `created_time`) and `shippingPayerIds` (`1` = seller pays vs. `2` = buyer pays)** by toggling UI controls and reading the resulting URL.
5. **Test unauthenticated scroll depth & `patchright`/`nodriver` behavior** on a Windows residential IP to see whether a login modal interrupts scrolling after N batches or Turnstile triggers on repeated searches.

---

## 7. References

*Note: Web research was conducted via `search_web` in November 2026, which returns synthesized summaries backed by grounding redirects (`vertexaisearch.cloud.google.com/grounding-api-redirect/...`). Exact canonical URLs observed directly in tool output are listed below; claims drawn from domain-level grounding summaries are tagged accordingly.*

### Primary / Official Mercari References
* **Mercari US Terms of Service:** `https://www.mercari.com/tos/` (prohibits robots, spiders, scrapers, and automated access).
* **Mercari US Prohibited Conduct Policy:** `https://www.mercari.com/us/help_center/article/339/`
* **Mercari US Condition Guidelines:** `https://www.mercari.com/us/help_center/topics/listings/item-conditions/conditions/`
* **Mercari US `robots.txt`:** `https://www.mercari.com/robots.txt` (referenced in `browser-use.com` and `github.com` grounding summaries).
* **Mercari US Help Center (Shipping & Buyer Protection Fee 3.6% / Seller Fee 10% effective Jan 6, 2025):** `mercari.com/us/help_center` (via `mercari.com` grounding summaries).
* **Mercari Shops GraphQL API (Japan B2C/B2B — distinct from Mercari US):** `https://api.mercari-shops.com/v1/graphql` (via `mercari-shops.com` and `blueprism.com` grounding summaries).
* **Mercari Engineering Blog (DPoP OIDC/OAuth security, GraphQL, gRPC/Connect BFF architecture):** `engineering.mercari.com` (via `mercari.com` grounding summaries).

### Secondary / Community & Open-Source References
* **`adamgauthier/mercari-client` (Node.js Mercari US wrapper, archived mid-2026):** `https://github.com/adamgauthier/mercari-client`
* **`take-kun/mercapi` (Mercari Japan `mercari.jp` async Python client):** `https://github.com/take-kun/mercapi` / `https://pypi.org/project/mercapi/`
* **`SteveShin323/carimer-api` (Mercari Japan `mercari.jp` client):** `https://github.com/SteveShin323/carimer-api`
* **`EricMeteorite/mercapi_shops` (Mercari Shops `mercari-shops.com` client):** `https://github.com/EricMeteorite/mercapi_shops`
* **`philipperemy/mercari-python-api`:** `https://github.com/philipperemy/mercari-python-api`
* **Agent Browser Automation & Reverse-Engineering Notes:** `browse.sh` (Mercari US skill documenting `401 Unauthorized` on cookieless `/v1/api` and CDP interception), `browser-use.com` (documenting `searchFacetQuery`, `data.search.itemsList`, `itemConditions`, `itemStatuses`, `sortBy`, `nextKey: "0"`, and Cloudflare `403`), `apify.com` (Mercari US scraper schemas for `shippingPayerIds`, `sortBy`, `itemConditions`), `dealhunter.io`, `sandbase.ai`, `compsniper.com` (URL parameter examples).
* **Marketplace News Coverage (Mercari Local Nov 2024 discontinuation & 2025 fee changes):** `valueaddedresource.net` (via grounding summaries).
