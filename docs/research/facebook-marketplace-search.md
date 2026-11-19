# Research: Facebook Marketplace Search Access and Marketplace Filters

- **Issue:** [#5](https://github.com/kt31229/unified-marketplace-search/issues/5)
- **Research Date:** November 2026 (2026-11-19)
- **Scope:** `$0/month` options for querying live Facebook Marketplace **Listings** on demand for personal local use on Windows, mapping **Unified Filters** to Facebook **Marketplace Filters**, and documenting returned **Listing** fields, login walls, location/radius behavior, Windows browser-profile caveats, and personal-account risks.

---

## Methodology & Verification Note

- **Primary Documentation** (`developers.facebook.com`, `facebook.com`, `developer.chrome.com`, `playwright.dev`) was verified directly via web search for official API availability, legal terms, Windows browser security changes, and Playwright APIs.
- **Secondary / Community Observations** (open-source GitHub repositories, technical scrapers/articles, Reddit `r/FacebookMarketplace` threads, Stack Overflow, Microsoft/Chromium issue threads) are explicitly labeled as community observations. Where search grounding returned opaque redirect links (`vertexaisearch.cloud.google.com/grounding-api-redirect/...`) that could not be HTTP-resolved inside the offline sandbox, only the verified host/project names are cited without fabricating unverified deep paths.
- **Unverified Edge Cases** (exact multi-select syntax, minor URL parameter spelling differences across regions/A-B tests, and exact live GraphQL `doc_id` hashes) are flagged explicitly so they can be checked in a single live browser session during implementation.

---

## Executive Summary

| `$0/month` Approach on Windows | Feasibility | Reliability | Personal-Account & ToS Risk | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **Official Meta APIs** (Graph API / Commerce Platform / Meta Content Library) | **Not viable** | N/A | None (if authorized) | No public API exists to search peer-to-peer consumer **Listings**. |
| **Unofficial Direct HTTP / GraphQL** (`/api/graphql/` via Python/Node) | Low | **Low** (fragile `doc_id`s, TLS fingerprinting, CSRF/tokens) | **Very High** | Not recommended; frequent breakage and fast anti-bot flagging. |
| **Local Browser Automation Reusing Logged-In Profile** (Playwright + real Chrome/Edge on Windows, intercepting GraphQL/embedded JSON) | **Viable** | **Medium–High** (resists CSS churn if parsing GraphQL JSON) | **High** (conflicts with Meta Automated Data Collection Terms; personal-account penalty risk) | **Only viable `$0/month` technical option**, strictly for low-frequency, user-initiated on-demand **Saved Searches** inside a dedicated Windows browser profile. |

> **Out-of-Scope Note:** Commercial third-party scraping SaaS offerings (e.g., Apify, Bright Data, Scrapfly) are excluded because they do not satisfy the `$0/month` local-first personal-use constraint.

---

## 1. Official Meta APIs and Legal / Terms Constraints (Primary Documentation)

### 1.1 Official APIs Do Not Support Consumer Listing Search
Meta provides **no public API** to query or search general peer-to-peer Facebook Marketplace **Listings** as a buyer:

- **Commerce Platform & Marketplace Partnerships** (`https://developers.facebook.com/docs/commerce-platform`, `/docs/commerce-platform/marketplace`, `/docs/marketing-api/catalog/reference`): Official endpoints such as `POST https://graph.facebook.com/{version}/{catalog_id}/items_batch` exist strictly for approved merchants and enterprise partners to upload, update, or delete *their own* catalog inventory (`PRODUCT_ITEM` batches of up to 300 entries)—not to query third-party peer-to-peer **Listings**.
- **Meta Content Library** (`https://developers.facebook.com/docs/content-library/docs/facebook-marketplace`, exposing paths such as `facebook/marketplace-listings/preview`): Restricted to vetted academic and non-profit researchers via Meta's Research Tools review process; unavailable for personal or local consumer applications.

### 1.2 Meta Terms of Service & Automated Data Collection Terms
Meta's official policies explicitly prohibit unauthorized automated extraction regardless of authentication state:

- **Terms of Service (Section 3.2.3)** (`https://www.facebook.com/legal/terms`) and **Automated Data Collection Terms** (`https://www.facebook.com/legal/automated_data_collection_terms`, `https://www.facebook.com/apps/site_scraping_tos_terms.php`):
  > *"You may not access or collect data from our Products using automated means (without our prior permission) or attempt to access data you do not have permission to access, regardless of whether such automated access or collection is undertaken while logged-in to a Facebook account."*
- **Meta Platform Terms** (`https://developers.facebook.com/docs/legal/terms-and-policies/meta-platform-terms`): Official Platform APIs (`graph.facebook.com`) are the sole authorized programmatic access route. Any local browser automation or unofficial GraphQL client therefore operates outside Meta's Terms of Service and carries account enforcement risk even for personal `$0/month` use.

---

## 2. Unofficial `$0/month` Technical Options on Windows

### 2.1 Option A: Direct Unofficial GraphQL Requests (`/api/graphql/`) — Not Recommended
Community open-source projects (`github.com`, e.g., `Eitol/facebook_simple_scraper` and related scripts) document that the Facebook web frontend queries `https://www.facebook.com/api/graphql/` via `POST` (`application/x-www-form-urlencoded`) using variables such as `doc_id`, `fb_api_req_friendly_name` (including `CometMarketplaceSearchContentPaginationQuery` for scrolling pagination), `bqf`, `browse_request_params` (`filter_location_latitude`, `filter_location_longitude`, `filter_radius_km`, `filter_price_lower_bound`, `filter_price_upper_bound`), and `custom_request_params` (`surface: 'SEARCH'`, `search_vertical: 'C2C'`).

**Why this fails as a maintainable local option:**
1. **Rotating `doc_id` hashes and tokens:** Meta frequently rotates GraphQL document IDs and requires valid session cookies (`c_user`, `datr`, etc.) and dynamic CSRF/form tokens.
2. **TLS/HTTP2 & anti-bot rejection:** Standard HTTP clients (`requests`, `httpx`, `fetch`) lack real browser TLS/JS execution fingerprints and quickly receive JS challenges, CAPTCHAs, or login redirects (community reports via `scrapfly.io`, `daily.dev`).

### 2.2 Option B: Local Browser Automation Reusing a Logged-In Windows Profile (Viable `$0/month` Path)
Using Playwright (`https://playwright.dev/docs/api/class-browsertype`) to drive an installed Chromium browser (`channel: 'chrome'` or `channel: 'msedge'`) on Windows reuses the user's real residential IP, genuine TLS/browser stack, and existing logged-in Facebook session.

Playwright provides two attachment modes:

1. **`browserType.launchPersistentContext(userDataDir, options)`** (`https://playwright.dev/docs/api/class-browsertype`):
   - Launches Chrome or Edge directly against a persistent `userDataDir` on disk (`headless: false` recommended), returning a `BrowserContext` with persisted cookies, `localStorage`, and Marketplace location preferences.
   - Higher Playwright fidelity than CDP attachment.
2. **`browserType.connectOverCDP(endpointURL)`** (`https://playwright.dev/docs/api/class-browsertype`):
   - Attaches to an already-running Chrome/Edge instance launched externally with `--remote-debugging-port=9222` and a custom `--user-data-dir`.
   - Official Playwright docs note lower fidelity than native Playwright connections because commands translate through CDP.

#### Critical Windows Profile & Security Caveats
Three Windows/Chromium behaviors dictate how profile reuse must be configured:

1. **Chrome 136+ / Edge 136+ Remote Debugging Restriction (`https://developer.chrome.com/blog/remote-debugging-port`):**
   - Starting in Chrome 136 (and inherited by Chromium-based Microsoft Edge 136+ per `microsoft.com` / `github.com` community tracking), `--remote-debugging-port` and `--remote-debugging-pipe` are **blocked/ignored on the default `User Data` directory** to protect against infostealers bypassing App-Bound Encryption.
   - **Impact:** You **cannot** attach CDP to the user's normal default Chrome/Edge profile (`%LOCALAPPDATA%\Google\Chrome\User Data` or `%LOCALAPPDATA%\Microsoft\Edge\User Data`). Both `chrome.exe` and `msedge.exe` require an explicit non-default `--user-data-dir` (e.g., `--remote-debugging-port=9222 --user-data-dir="C:\path\to\automation-profile"`).
2. **Windows Profile Locking (`SingletonLock`, `SingletonCookie`, `SingletonSocket`):**
   - Chromium enforces single-instance locking on Windows. Calling `launchPersistentContext` on a `userDataDir` that is already open in a running Chrome/Edge window triggers *"Opening in existing browser session"* and immediately exits (`stackoverflow.com`, `github.com`).
   - **Impact:** Using a **dedicated automation profile directory** avoids forcing the user to close their main browser before every search, and isolates Playwright from stale lock files (though abrupt crashes can still leave lock files requiring cleanup).
3. **App-Bound Encryption on Windows (Chrome 127+):**
   - Chrome on Windows encrypts cookies/tokens via App-Bound Encryption tied to the official browser binary path (`chromium.org`, `devoteam.com`). Copying raw cookie files from the default Chrome profile into another folder or Playwright's bundled Chromium binary fails decryption.
   - **Impact:** Launch the official installed browser (`channel: 'chrome'` or `channel: 'msedge'`) against the dedicated `userDataDir` and have the user sign in to Facebook manually once inside that dedicated window (or persist Playwright `storageState`), rather than copying raw SQLite cookie files from the primary browser profile.

#### Recommended Extraction Strategy Inside the Browser
Community scrapers (`github.com`, `scrapfly.io`, `browse.sh`) note that Meta frequently obfuscates and rotates CSS class names in the DOM, breaking selector-based scrapers. Instead:
- **Primary extraction:** Listen to browser network responses (`page.on('response', ...)` in Playwright) for `https://www.facebook.com/api/graphql/` JSON payloads (e.g., `CometMarketplaceSearchContentPaginationQuery` and search queries) and parse initial SSR JSON blobs inside `<script>` tags containing `__typename` nodes (`MarketplaceProductItem` / `GroupCommerceProductItem`).
- **Secondary fallback:** Extract visible card anchor `href` (`/marketplace/item/<id>/`), image `src`, and text lines from DOM only if GraphQL payload keys shift.

---

## 3. Login Wall, Location/Radius Requirements, and Account Risks

### 3.1 Login Wall Behavior (2025–2026 Community Observations)
Community reports (`reddit.com`, `daily.dev`, `data365.co`) indicate that searching Facebook Marketplace while logged out is heavily blocked:
- Direct public links may briefly render an initial preview or partial page, but running searches, paginating, scrolling, or switching location triggers an unclosable *"Log In / Sign Up"* wall because feed-loading scripts require an authenticated session.
- **Implication:** Reliable live search and pagination requires a logged-in Facebook session.

### 3.2 Location, City Slug, and Radius Mechanics
- **URL City / Location Slug:** Search URLs accept a city slug or numeric location ID in the path: `https://www.facebook.com/marketplace/<city-slug>/search/?...` (e.g., `newyork`, `seattle`, `chicago`) or `https://www.facebook.com/marketplace/search/?...` (community references: `browse.sh`, `reddit.com`).
- **UI & GraphQL Radius:** Facebook's Marketplace UI allows choosing a city/ZIP/map pin and a radius slider (up to 500 miles in US UI per community guides; `filter_location_latitude`, `filter_location_longitude`, and `filter_radius_km` in internal GraphQL payloads).
- **Important URL Radius Caveat:** Although some community guides (`carsnipe.com`) mention `?radius=<n>` in URLs, multiple community observations (`openmarket.io` and scraper issues) note that Facebook's SPA frequently ignores or overrides raw URL `radius=` query parameters using the account/cookie-stored `marketplace_location` state or falls back to a `"Suggested"` radius. Additionally, **Shipping** and **Sponsored/Promoted** **Listings** appear outside the local geographic radius unless **Local Pickup** is selected (`openmarket.io`).
- **Practical Implication:** The user should set their default city/radius once inside the dedicated automation profile's Marketplace UI (persisting it in account/cookie state), or the adapter should drive the UI location picker / inspect GraphQL location variables if per-**Saved Search** location changes are needed. *(Exact persistence behavior of `?radius=` vs GraphQL location variables should be verified in a live session.)*

### 3.3 Anti-Bot Defenses and Personal-Account Risk
Meta's External Data Misuse (EDM) defenses (`fb.com` engineering references cited in search summaries) and behavioral classifiers actively monitor Marketplace because it sits behind authentication:
- **Triggers:** High request frequency, parallel tabs, headless browser signatures (`navigator.webdriver` / default headless Chromium), rapid scrolling without pauses, or automated credential login flows.
- **Penalty Progression (Community Reports on `reddit.com`, `github.com`):**
  1. **Security Checkpoint:** CAPTCHA, SMS/email code, or selfie/ID verification.
  2. **Commerce Restriction:** `"Marketplace isn't available"` — Marketplace access removed while the main Facebook profile remains active.
  3. **Account Suspension / Disablement:** Loss of personal Facebook account, Messenger history, photos, and connected logins, plus possible device/IP association bans with low appeal success.
- **Risk Reduction Guardrails (Does Not Eliminate ToS Risk):**
  - Strictly **on-demand** execution triggered by explicit user action (no scheduled background polling or high-volume fan-out).
  - Run **headed** (`headless: false`) using genuine Chrome or Edge (`channel: 'chrome'` / `'msedge'`).
  - Manual one-time login by the user (never automate typing passwords/2FA).
  - Enforce natural pacing between queries and scroll steps, fetch only the first page(s) needed, and abort immediately on any login prompt or checkpoint.

---

## 4. Supported Marketplace Filters

Facebook Help guidelines (summarized via secondary guides) and community URL/GraphQL analyses identify the following **Marketplace Filters** and how they map from **Unified Filters**:

| Unified Filter | Marketplace Filter (URL Query / Path) | Supported Values & Behavior | Verification Status & Notes |
| :--- | :--- | :--- | :--- |
| **Keywords** | `query=` + optional `exact=` | URL-encoded keyword string; `exact=true` or `exact=false` (`false` allows broader matching). | Community-verified (`reddit.com`, `github.com`). |
| **Price Range** | `minPrice=`, `maxPrice=` (GraphQL: `filter_price_lower_bound`, `filter_price_upper_bound`) | Integer bounds in local currency. | Community-verified (`reddit.com`, `carsnipe.com`, `browse.sh`). |
| **Condition** | `itemCondition=` | `new`, `used_like_new`, `used_good`, `used_fair`. | Individual values community-verified; **unverified**: exact separator format for multi-select (`%2C` vs repeated keys) in current 2026 web UI. |
| **Size** | **None** (not a general URL filter) | No general `size=` **Marketplace Filter** exists. Apparel/footwear (`https://www.facebook.com/marketplace/category/apparel`) use category-specific UI/profile facets. | Community-verified (`reddit.com`). **Workaround:** append size terms into `query=` and optionally scope by category. |
| **Location / Radius** | Path: `/marketplace/<city-slug>/search/` (or `/<location_id>/search/`); GraphQL: `filter_location_latitude`, `filter_location_longitude`, `filter_radius_km` | City slug/ID selects market center; UI radius up to ~500 miles. `radius=` URL param is inconsistently respected/overridden by session location state. | City slug verified; `?radius=` URL reliability **unverified/inconsistent**—prefer UI-persisted profile location or GraphQL variables. |
| **Sort Options** | `sortBy=` | `creation_time_descend` (Newest first), `price_ascend` (Price low→high), `price_descend` (Price high→low), `distance_ascend` (Nearest first), `best_match` / `suggested`. | Community-verified (`reddit.com`, `github.com`, `connie.ai`). Meta still interleaves sponsored/suggested **Listings**. |
| **Delivery / Pickup** *(Unified or extra)* | `deliveryMethod=` | `local_pick_up` (restricts to local radius) vs shipping (`shipped` in `reddit.com`/`carsnipe.com` examples; some guides mention `shipping`). | `local_pick_up` verified; **unverified**: exact current URL enum for shipping (`shipped` vs `shipping`) in 2026 web UI. |
| **Date Listed** *(extra)* | `daysSinceListed=` | Recency window in days (e.g., `1`, `7`, `30`). | Community-verified (`carsnipe.com`, `reddit.com`). |
| **Category** *(extra)* | Path `/marketplace/category/<slug>` or `category_id=` | Scopes search to a Marketplace department (e.g., `apparel`). | Community-verified (`reddit.com`). Exact numeric `category_id` mapping varies by locale. |
| **Availability** *(extra)* | `availability=in_stock` (URL) / `is_sold`, `is_pending` (GraphQL) | Some community examples pass `availability=in_stock`, while others note availability state is primarily filtered in GraphQL payloads rather than consumer URLs. | **Partially unverified** for general peer-to-peer search URLs; reliably checked via `is_sold` / `is_pending` in GraphQL JSON. |
| **Pagination** | GraphQL cursor (`CometMarketplaceSearchContentPaginationQuery`) | Infinite-scroll cursor-based Relay pagination (`cursor` / `after` / `count`, `page_info.end_cursor`). No `?page=N` URL parameter. | Community-verified (`github.com`, `habr.com`). Browser automation triggers next batch via scroll. |

---

## 5. Returned Listing Fields

When intercepting internal GraphQL responses (`/api/graphql/` nodes such as `MarketplaceProductItem` / `GroupCommerceProductItem`) or parsing embedded SSR `<script>` JSON, community scrapers (`github.com`, `scrapfly.io`, `scrapecreators.com`, `browse.sh`, `apify.com`) document the following **Listing** fields on search feed entries:

| Canonical Listing Field | GraphQL / Embedded JSON Path | Format / Notes |
| :--- | :--- | :--- |
| **Title** | `marketplace_listing_title` (fallback `custom_title`) | Plain string title of the **Listing**. |
| **Price** | `listing_price.formatted_amount` (or `.text`), `listing_price.amount`, `listing_price.amount_with_offset_in_currency` | Formatted string (e.g., `"$200"`), decimal string (`"200.00"`), and minor-unit integer; `strikethrough_price` may appear on discounted **Listings**. |
| **Shipping / Pickup Indicator** | `delivery_types` (array) | Values include `IN_PERSON` (plus `PUBLIC_MEETUP`, `DOOR_PICKUP`, `DOOR_DROPOFF`) and `SHIPPING` (also surfaced in UI via shipping badge / truck icon). |
| **Thumbnail** | `primary_listing_photo.image.uri` | Direct CDN image URL for the primary photo. |
| **Direct URL** | `https://www.facebook.com/marketplace/item/<id>/` | Constructed from listing `id` (or read from feed card `<a href>`). |
| **Location** *(useful metadata)* | `location.reverse_geocode` (`city`, `state`) | City/state label shown on the card. |
| **Status Flags** *(useful filter)* | `is_sold`, `is_pending` | Booleans indicating sold or offer-pending **Listings** so the aggregator can exclude or badge them. |

> **Feed vs. Detail Page Tradeoff:** Full multi-paragraph descriptions, seller profile metrics, and complete photo galleries often require fetching individual **Listing** URLs (`/marketplace/item/<id>/`), multiplying HTTP requests and account risk. For an aggregator summary view, extracting the feed GraphQL payload alone supplies title, price, shipping/pickup indicator, thumbnail, location, status flags, and direct URL in a single search pass.

---

## 6. References & Open Verification Checklist

### Verified Primary References
- Meta Commerce Platform Docs: `https://developers.facebook.com/docs/commerce-platform`
- Meta Marketplace Partnerships / Catalog API Reference: `https://developers.facebook.com/docs/commerce-platform/marketplace`, `https://developers.facebook.com/docs/marketing-api/catalog/reference`
- Meta Content Library — Facebook Marketplace Docs: `https://developers.facebook.com/docs/content-library/docs/facebook-marketplace`
- Meta Platform Terms: `https://developers.facebook.com/docs/legal/terms-and-policies/meta-platform-terms`
- Meta Terms of Service: `https://www.facebook.com/legal/terms`
- Meta Automated Data Collection Terms: `https://www.facebook.com/legal/automated_data_collection_terms` and `https://www.facebook.com/apps/site_scraping_tos_terms.php`
- Facebook Help Center: `https://www.facebook.com/help`
- Chrome 136+ Remote Debugging Security Changes: `https://developer.chrome.com/blog/remote-debugging-port`
- Playwright `BrowserType` API (`launchPersistentContext`, `connectOverCDP`): `https://playwright.dev/docs/api/class-browsertype`

### Secondary / Community References Consulted (via Web Search Grounding)
- Open-source GitHub repositories & discussions (`github.com`, including `Eitol/facebook_simple_scraper` and GraphQL search/Playwright profile-lock issues)
- Technical scraper engineering references (`scrapfly.io`, `scrapecreators.com`, `browse.sh`, `apify.com`, `habr.com`, `daily.dev`, `data365.co`)
- Community Marketplace filter & ban discussions (`reddit.com` `r/FacebookMarketplace`, `carsnipe.com`, `openmarket.io`, `connie.ai`)
- Windows Chrome/Edge App-Bound Encryption & lock discussions (`chromium.org`, `microsoft.com`, `devoteam.com`, `stackoverflow.com`)

### Details Requiring Live Windows Prototype Verification
Before writing production adapter code, verify these exact runtime details once in a local Windows browser DevTools Network tab:
1. Exact current GraphQL response JSON path around `CometMarketplaceSearchContentPaginationQuery` / initial search SSR script payload.
2. Whether `?radius=` in `facebook.com/marketplace/<city>/search/?...` alters live Listings or is overridden by `marketplace_location` session state.
3. Exact URL parameter values for `deliveryMethod` shipping (`shipped` vs `shipping`) and multi-value `itemCondition` encoding.
