# Research Report: eBay Search Access & Marketplace Filters

- **Issue:** [#2 — Research eBay search access and Marketplace Filters](https://github.com/kt31229/unified-marketplace-search/issues/2)
- **Research Date:** November 2026
- **Target Scope:** \$0/month official eBay API access for querying live eBay **Listings** on demand for personal local use on Windows
- **Methodology:** Investigated against official eBay Developer documentation (`developer.ebay.com`). Statements derived from secondary/community references or showing conflicts across retrieved snippets are explicitly marked.

---

## Executive Summary

For personal local use on Windows at **\$0/month**, the **eBay Buy Browse API** (`GET https://api.ebay.com/buy/browse/v1/item_summary/search`) is the **only** active official eBay API for keyword- and filter-based searching of live **Listings**. The legacy **Finding API** and **Shopping API** were officially deprecated and **decommissioned on February 5, 2025** ([API Deprecation Status](https://developer.ebay.com/develop/apis/api-deprecation-status); [Legacy APIs Migration Paths](https://developer.ebay.com/support/rest-api-migration)).

Using the Browse API on a Windows desktop works cleanly at the protocol level via **OAuth 2.0 Client Credentials Grant** (`api_scope`), requiring no user browser login and providing a **5,000 calls/day** default Production quota. However, **two critical non-technical gates** affect personal local applications:
1. **Marketplace Account Deletion/Closure Notification Compliance:** Production keysets remain inactive unless you either run a public HTTPS webhook or submit an **Exemption** (*"Not persisting eBay data"*). Local-only on-demand search fits the exemption, but persisting full Listing snapshots or seller data for **Watchlists** or caching must be checked carefully against the exemption terms.
2. **Buy API Eligibility / Application Growth Check (AGC) Ambiguity:** While Browse API documentation indicates developers can start with standard Application Access Tokens and a 5,000/day default quota, general Buy API eligibility guidance characterizes several Buy APIs as **Limited Release** intended for partners, businesses, or eBay Partner Network (EPN) affiliates. Whether a newly registered individual developer keyset can immediately execute `item_summary/search` in Production at 5,000/day without business/AGC approval could not be conclusively verified from static docs alone and should be tested directly upon account creation.

---

## 1. Official \$0/Month API Options & Deprecated Alternatives

| Official eBay API | Status (Nov 2026) | Cost | Personal Local Search Viability | Primary Reference |
| :--- | :--- | :--- | :--- | :--- |
| **Buy Browse API** (`GET /buy/browse/v1/item_summary/search`) | **Active** | \$0/month (5,000 calls/day default) | **Primary Option.** Designed for live **Listing** search with keywords, **Marketplace Filters**, and pagination. | [Browse API Overview](https://developer.ebay.com/api-docs/buy/browse/overview.html); [`item_summary/search`](https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search) |
| **Buy Browse API** (`POST /buy/browse/v1/item_summary/search_by_image`) | **Active** (experimental/specialized) | \$0/month (within Browse quota) | Image-based search (Base64 image payload); not a replacement for text/filter search. | [Browse API Methods](https://developer.ebay.com/api-docs/buy/browse/resources/methods) |
| **Finding API** & **Shopping API** | **Decommissioned (Feb 5, 2025)** | N/A | **Dead.** Officially retired and replaced by the Buy Browse API. | [API Deprecation Status](https://developer.ebay.com/develop/apis/api-deprecation-status); [Legacy APIs Migration Paths](https://developer.ebay.com/support/rest-api-migration) |
| **Buy Marketplace Insights API** | **Limited Release** | Contract/Approval gated | **Unavailable for personal self-serve.** Holds historical sold/completed **Listings**; requires business approval. | [Marketplace Insights Overview](https://developer.ebay.com/api-docs/buy/marketplace-insights/overview.html); [Buy APIs Overview](https://developer.ebay.com/api-docs/buy/static/buy-apis-overview.html) |
| **Buy Feed API / Feed Beta API** | **Limited Release** | Approval gated | **Unsuitable.** Bulk file downloads require business/partner approval and disqualify the keyset from Marketplace Account Deletion exemption. | [Feed API Overview](https://developer.ebay.com/api-docs/buy/feed/overview.html); [Buy APIs Overview](https://developer.ebay.com/api-docs/buy/static/buy-apis-overview.html) |
| **Buy Deal, Order, Offer, Marketing APIs** | **Limited Release** | Approval gated | **Not applicable.** Checkout (`Order` requires a registered domestic business entity), bidding (`Offer`), curated deals, or promotional merchandising. | [Buy APIs Overview](https://developer.ebay.com/api-docs/buy/static/buy-apis-overview.html) |

*Supporting metadata APIs (free under the same developer account) needed to translate **Unified Filters** accurately:*
- **Taxonomy API** (`getItemAspectsForCategory`): Discovers valid category-specific aspect names (e.g., `Size`, `US Shoe Size`) per leaf category ([eBay Developers Program](https://developer.ebay.com/) — exact subpage path not directly resolved from search redirect).
- **Metadata API** (`getItemConditionPolicies`): Discovers valid numeric `conditionIds` supported by each eBay category ([eBay Developers Program](https://developer.ebay.com/) — exact subpage path not directly resolved from search redirect).

---

## 2. Registration, Keyset Activation & Approval Requirements

### 2.1 Developer Account & Keyset Structure
- **Account Setup:** Free registration on the [eBay Developers Program portal](https://developer.ebay.com/) yields two environment keysets, each with a `Client ID` (App ID) and `Client Secret` (Cert ID):
  - **Sandbox:** Isolated test environment with essentially unrestricted call volume, **but contains mock/test data only**—not live eBay **Listings** ([eBay Developers Program](https://developer.ebay.com/)).
  - **Production:** Live eBay **Marketplace** data; credentials are environment-specific and cannot be mixed with Sandbox endpoints.

### 2.2 Production Keyset Activation: Marketplace Account Deletion Compliance
All Production keysets are disabled/non-compliant until the developer completes the **Marketplace Account Deletion/Closure Notifications** workflow ([eBay Developers Program](https://developer.ebay.com/)). Because a Windows desktop app cannot easily expose a public HTTPS webhook endpoint, the practical path is the **Exemption** workflow:
1. Sign in to [eBay Developers Program](https://developer.ebay.com/) → **Application Access Keys** → **Production**.
2. Open the **Marketplace Account Deletion** notifications section.
3. Toggle **"Not persisting eBay data"** to **On** and confirm.
4. Choose the exemption reason (*"I do not persist eBay data"*) and submit an explanation stating the tool performs real-time on-demand queries without storing user PII.
5. Submission activates the Production keyset if eligible.

> **Important Caveat for Local Persistence:** Exemption is strictly for apps that do **not** persist eBay user data or PII (unlike Feed API consumers or user-data caches). Storing **Saved Searches** (user query strings + **Unified Filters**) does not persist eBay user PII, and storing minimal **Watchlist** pointers (`itemId`, `itemWebUrl`) rather than full seller PII is safer—though exact compliance with the exemption wording and eBay API License Agreement should be verified in the portal's exemption prompt.

### 2.3 Application Growth Check (AGC) & Individual Developer Eligibility (Partially Unverified)
Documentation retrieved from `developer.ebay.com` shows two overlapping policies that warrant explicit verification before relying on Production access:
- **Standard Browse Onboarding:** `buy/browse/overview.html` states that while Deal, Feed, Marketing, Offer, and Order APIs are **Limited Release**, the Browse API lets developers get started with standard Application Access Tokens, and Production keysets receive a default **5,000 calls/day** limit for initial integration and small-scale usage ([Browse API Overview](https://developer.ebay.com/api-docs/buy/browse/overview.html)).
- **Limited Release / Business Review Risk:** General Buy API eligibility summaries state that Buy APIs are geared toward partners, registered businesses, and approved EPN affiliates, and that pure personal/hobbyist integrations may face hurdles during manual **Application Growth Check** reviews (which inspect business model, call efficiency, and hourly/daily peaks) ([eBay Developers Program](https://developer.ebay.com/)).
- **What Remains Unverified:** Whether a newly created **individual** developer account in 2026 can call `GET /buy/browse/v1/item_summary/search` in Production at 5,000 calls/day **immediately** after submitting the Marketplace Account Deletion exemption—or whether eBay now enforces an upfront AGC/EPN approval gate even for `item_summary/search`—was ambiguous across retrieved doc summaries and must be validated with a test account.

---

## 3. OAuth 2.0 Authentication Flow

The Browse API `item_summary/search` endpoint queries public **Listing** data and uses the **OAuth 2.0 Client Credentials Grant** (Application Access Token). **User-level Authorization Code Grants (browser login/consent) are not required** for public **Listing** search ([Browse API Overview](https://developer.ebay.com/api-docs/buy/browse/overview.html); [eBay Developers Program](https://developer.ebay.com/)).

### Token Minting (`client_credentials`)
- **Production Endpoint:** ``POST https://api.ebay.com/identity/v1/oauth2/token``
- **Sandbox Endpoint:** ``POST https://api.sandbox.ebay.com/identity/v1/oauth2/token``
- **Headers:**
  - `Authorization: Basic <Base64("<client_id>:<client_secret>")>`
  - `Content-Type: application/x-www-form-urlencoded`
- **Form Body:**
  - `grant_type=client_credentials`
  - `scope=https://api.ebay.com/oauth/api_scope`
- **Token Lifetime & Renewal:** Returns JSON with `access_token`, `token_type: "Application Access Token"`, and `expires_in: 7200` (**2 hours / 120 minutes**). Client Credentials Grants do **not** return a refresh token; the local Windows client simply caches the token in memory and requests a fresh token before expiry.

### Search Request Headers
Every `GET https://api.ebay.com/buy/browse/v1/item_summary/search` request uses:
- `Authorization: Bearer <access_token>` (required)
- `X-EBAY-C-MARKETPLACE-ID: EBAY_US` (required for US eBay **Marketplace**; other country codes apply for non-US **Marketplaces**)
- `Accept: application/json`
- `X-EBAY-C-ENDUSERCTX: contextualLocation=country=US,zip=95008` (optional but strongly recommended for accurate shipping calculations, `price`/`-price` sorting including shipping, and `itemLocationRegion:WORLDWIDE` ship-eligibility accuracy) ([`item_summary/search`](https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search); [Buy API Field Filters](https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html)).

---

## 4. Free-Tier Rate Limits & Quotas

- **Price:** **\$0/month** under standard developer registration.
- **Default Production Quota:** **5,000 API calls per day** per application keyset (shared across the app, not per end user) ([eBay Developers Program](https://developer.ebay.com/)).
- **Monitoring:** Programmatically inspect remaining calls and reset timestamps via the **Developer Analytics API** (`getRateLimits` for app-level quotas; `getUserRateLimits` for user-scoped quotas) ([eBay Developers Program](https://developer.ebay.com/)).
- **Quota Increases:** Higher tiers (e.g., 50,000+ calls/day) require submitting a free **Application Growth Check** in the developer dashboard ([eBay Developers Program](https://developer.ebay.com/)).
- **Unverified Burst Limit:** Exact per-second or per-minute burst thresholds for `item_summary/search` were not stated in retrieved primary doc summaries and remain unverified. For a single-user local Windows search aggregator running on-demand searches with `limit=200`, 5,000 calls/day provides ample headroom unless background polling of many **Saved Searches** runs too frequently.

---

## 5. Supported Marketplace Filters (`item_summary/search`)

Endpoint: `GET https://api.ebay.com/buy/browse/v1/item_summary/search` ([`item_summary/search`](https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search); [Buy API Field Filters](https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html)).  
At least one primary constraint (`q`, `category_ids`, `epid`, `gtin`, or `charity_ids`) is required. All special characters (`[]`, `{}`, `|`, `""`, spaces, commas) must be properly URL-encoded.

### 5.1 Keywords (`q`) & Description Search
- **Implicit AND:** Space-separated words match **Listings** containing all terms (`q=nike running shoes`).
- **Boolean OR:** Parentheses with comma-separated alternatives, e.g., `q=camera (digital,slr)` or `q=(blue,red)(t-shirt,trousers)` *(secondary/third-party guides note avoiding spaces around commas inside parentheses)*.
- **Exclusion (NOT):** Leading `-` before a word or grouped parentheses, e.g., `q=laptop -broken -parts` or `q=iphone -(pro,max)` *(no space after `-`)*.
- **Exact Phrase:** Double quotes, e.g., `q="nintendo switch oled"`.
- **Auto-Correct & Description Matching:** eBay's search engine applies automatic spelling correction / synonym substitution by default, though advanced operators (`()`, `-`, `""`) disable auto-correction and enforce literal matching ([eBay Developers Program](https://developer.ebay.com/); secondary guides). Passing `filter=searchInDescription:true` expands keyword matching from title-only to title + description ([Buy API Field Filters](https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html)). *(Exact `auto_correct` query parameter syntax/support in `item_summary/search` was not conclusively verified in retrieved primary reference summaries.)*
- **Character Limit:** Secondary guides recommend keeping `q` concise (under ~100–200 characters) to avoid `400 Bad Request` / gateway limits; exact official byte/character ceiling is unverified.

### 5.2 Price Range & Shipping Cost Filters
- **`price` & `priceCurrency`:** Inside `filter`: `filter=price:[10.00..50.00],priceCurrency:USD`. Supports open bounds (`price:[10.00]` for lower bound, `price:[..50.00]` for upper bound). `priceCurrency` uses a case-sensitive 3-letter ISO 4217 code and is required whenever `price` is specified ([Buy API Field Filters](https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html)).
- **`maxDeliveryCost`:** e.g., `filter=maxDeliveryCost:0` restricts matches to **Listings** with free shipping ([Buy API Field Filters](https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html)).
- **Mismatch Warning:** `filter=price:[..]` evaluates base **Listing** price only—it does **not** filter by `(price + shipping)`, whereas `sort=price` sorts by `(price + shipping)`.

### 5.3 Condition Taxonomy (`conditions` vs. `conditionIds`)
Browse API provides two condition **Marketplace Filters** inside `filter` ([Buy API Field Filters](https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html)):
1. **Broad Condition (`conditions`):** Case-sensitive enum accepting **only** `{NEW|USED|UNSPECIFIED}` (e.g., `filter=conditions:{NEW|USED}`). *(Note: One retrieved summary listed `USED_EXCELLENT` / `LIKE_NEW`, which contradicts `ref-buy-browse-filters.html`'s explicit rule that `conditions` is limited to `NEW`, `USED`, `UNSPECIFIED` and that sub-conditions require `conditionIds`.)*
2. **Granular Condition (`conditionIds`):** Pipe-delimited numeric IDs (e.g., `filter=conditionIds:{1000|1500|3000}`):
   - `1000` — New
   - `1500` — New other / Open Box
   - `2000` — Manufacturer / Certified Refurbished
   - `2500` — Seller Refurbished
   - `3000` — Used
   - `4000` — Very Good
   - `5000` — Good
   - `6000` — Acceptable
   - `7000` — For parts or not working
   - **Category Dependency:** Supported `conditionIds` vary by eBay category (some categories omit or repurpose specific IDs). Use **Metadata API** `getItemConditionPolicies` to inspect valid IDs per category ([eBay Developers Program](https://developer.ebay.com/)).

### 5.4 Size & Category-Specific Aspects (`aspect_filter`)
- **Syntax:** Must combine top-level `category_ids` with `aspect_filter`:
  `?q=sneakers&category_ids=15709&aspect_filter=categoryId:15709,Brand:{Nike|Adidas},US%20Shoe%20Size:{10|10.5}` ([`item_summary/search`](https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search)).
- **Critical Constraint:** `aspect_filter` **requires** declaring the category ID both in `category_ids` and inside `aspect_filter=categoryId:<ID>,...`. Aspect names and value vocabularies are category-dependent (e.g., `Size` vs. `US Shoe Size` vs. `Ring Size`).
- **Aspect Discovery:**
  - Dynamic histograms: Pass `fieldgroups=ASPECT_REFINEMENTS` in `item_summary/search` to get available aspects and counts for the active query.
  - Static schema: Call **Taxonomy API** `getItemAspectsForCategory` for a single leaf category ID.
- **Unified Filter Gap:** There is no cross-category `size` **Marketplace Filter** in eBay's Browse API. Filtering by size across multiple categories requires either embedding size text in `q` (less precise) or running category-scoped requests using `CATEGORY_REFINEMENTS` / pre-mapped category IDs.

### 5.5 Location, ZIP, Radius & Fulfillment Filters
Inside `filter` ([Buy API Field Filters](https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html)):
- **Shippable to ZIP:** `deliveryPostalCode:95125,deliveryCountry:US` (both required; **ignored** if local pickup filters are simultaneously included).
- **Local Pickup Radius Around ZIP:** Must supply **all five** filters together:
  `deliveryOptions:{SELLER_ARRANGED_LOCAL_PICKUP},pickupCountry:US,pickupPostalCode:95125,pickupRadius:25,pickupRadiusUnit:mi` (`pickupRadiusUnit` accepts `mi` or `km`).
- **Seller Geography:** `itemLocationCountry:US` (2-char ISO 3166) **or** `itemLocationRegion:NORTH_AMERICA` (cannot combine both; for `EBAY_US`, `NORTH_AMERICA` and `WORLDWIDE` are valid; `WORLDWIDE` recommends `X-EBAY-C-ENDUSERCTX`).
- **Location Gap:** Radius filtering (`pickupRadius` + `pickupPostalCode`) works **only** for local pickup **Listings** (`SELLER_ARRANGED_LOCAL_PICKUP`), not for shipped **Listings** within N miles of a ZIP code.

### 5.6 Buying Options & Other Useful Filters
- **`buyingOptions`:** `FIXED_PRICE`, `AUCTION`, `BEST_OFFER`, `CLASSIFIED_AD` (e.g., `filter=buyingOptions:{FIXED_PRICE|AUCTION}`) ([Buy API Field Filters](https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html)).
  - **CRITICAL DEFAULT TRAP:** If `buyingOptions` is omitted, `item_summary/search` returns **`FIXED_PRICE` only**, silently excluding auctions. To support unified searching across Buy It Now and auctions, explicitly pass `buyingOptions:{FIXED_PRICE|AUCTION}` (and optionally `BEST_OFFER`).
  - Note: Docs describe `buyingOptions` as leaf-category-defined (works best with `category_ids`), and auction **Listings** with active bids drop `FIXED_PRICE`.
- **Additional Filters:** `sellers:{user1|user2}` (max 250), `excludeSellers:{user1|user2}`, `returnsAccepted:true`, `bidCount:[1..5]`, `itemEndDate:[2026-12-31T00:00:00Z..]`.

### 5.7 Sort Options (`sort`)
Supported values for `sort` ([`item_summary/search`](https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search)):
- *Omitted* → **Best Match** (default relevance ordering; note that secondary snippets occasionally cited `bestMatch` or `relevance` strings, whereas official guidance specifies omitting `sort` for Best Match).
- `price` → Price + shipping ascending.
- `-price` → Price + shipping descending.
- `newlyListed` → Most recently listed first.
- `endingSoonest` → Closest end timestamp first.
- `distance` → Shortest distance ascending (valid only when local pickup filters and buyer location context are supplied).

### 5.8 Pagination & `fieldgroups`
- **`limit`:** `1`–`200` **Listings** per request (default `50`).
- **`offset`:** Zero-based integer offset (default `0`).
- **Hard Cap:** Total accessible **Listings** per query are capped at **10,000** (`offset` + `limit` cannot page past 10,000 matches) ([`item_summary/search`](https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search); secondary API guides).
- **`fieldgroups`:** Controls payload detail and facet histograms: `MATCHING_ITEMS` (default), `EXTENDED` (adds `shortDescription` and `itemLocation.city`), `ASPECT_REFINEMENTS`, `CATEGORY_REFINEMENTS`, and `BUYING_OPTION_REFINEMENTS` (other refinement groups may exist in the live schema).

---

## 6. Returned Listing Fields (`ItemSummary`)

`item_summary/search` returns a JSON payload containing `itemSummaries` (array of `ItemSummary` objects) alongside pagination metadata ([`item_summary/search`](https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search)):

| Requested Concept | `ItemSummary` Field(s) | Notes & Constraints |
| :--- | :--- | :--- |
| **Identifiers** | `itemId`, `legacyItemId`, `itemGroupHref`, `itemGroupType` | `itemId` uses REST format (`v1\|...`); multi-variation **Listings** surface group metadata requiring a follow-up call to `itemGroupHref` for per-variant pricing/stock. |
| **Title & Snippet** | `title`, `shortDescription` | `shortDescription` requires `fieldgroups=EXTENDED`. |
| **Price** | `price` (`value`, `currency`), `marketingPrice` | `price` applies to `FIXED_PRICE` **Listings**; may be absent on pure `AUCTION` **Listings**. |
| **Auction Bids** | `currentBidPrice` (`value`, `currency`), `bidCount` | Returned for `AUCTION` **Listings** instead of (or alongside) `price`. |
| **Buying Options** | `buyingOptions` (`string[]`) | Values such as `FIXED_PRICE`, `AUCTION`, `BEST_OFFER`, `CLASSIFIED_AD`. |
| **Condition** | `condition`, `conditionId` | Human-readable string plus numeric ID string (e.g., `"3000"`). |
| **Shipping & Pickup** | `shippingOptions[]` (`shippingCost`, `shippingCostType`, `minEstimatedDeliveryDate`, `maxEstimatedDeliveryDate`), `pickupOptions`, `distanceFromPickupLocation` | `shippingCost.value` is `"0.00"` for free shipping; accuracy depends on `X-EBAY-C-ENDUSERCTX`, and `shippingOptions` may be omitted/partial for calculated shipping or pickup-only **Listings**. |
| **Thumbnails & Images** | `image` (`imageUrl`), `thumbnailImages[]`, `additionalImageUrls[]` | Primary image, thumbnail URLs, and secondary gallery URLs. |
| **Direct URL** | `itemWebUrl`, `itemAffiliateWebUrl` | `itemWebUrl` links directly to the live eBay **Listing** web page. |
| **Location & Seller** | `itemLocation` (`city`, `stateOrProvince`, `postalCode`, `country`), `seller` (`username`, `feedbackPercentage`, `feedbackScore`) | `itemLocation.city` typically requires `fieldgroups=EXTENDED`; `postalCode` may be partially masked/abbreviated. |
| **Timestamps** | `itemCreationDate`, `itemOriginDate`, `itemEndDate` | ISO 8601 UTC timestamps (`itemOriginDate` reflects initial availability vs. relist date). |

---

## 7. Key Gaps & Constraints for Unified Marketplace Search

1. **Production Keyset Activation & AGC Uncertainty:** Must pass **Marketplace Account Deletion Exemption** (*"Not persisting eBay data"*) to unlock Production without a public HTTPS webhook; verify with a live developer account whether personal non-commercial keys can invoke `item_summary/search` immediately at 5,000 calls/day without hitting a business/EPN **Application Growth Check** gate.
2. **No Sold / Completed Listings:** `item_summary/search` returns active **Listings** only; historical sold data lives in the Limited Release **Marketplace Insights API**.
3. **Default `FIXED_PRICE`-Only Behavior:** Omitting `buyingOptions` hides all auctions—the eBay adapter must explicitly specify `buyingOptions:{FIXED_PRICE|AUCTION}`.
4. **Category-Locked Size / Aspect Filtering:** `aspect_filter` mandates a category ID (`category_ids` + `categoryId:...`) and category-specific aspect names, preventing a single cross-category size **Unified Filter** query.
5. **Pickup-Only Radius Filter:** `pickupRadius` + `pickupPostalCode` filters local-pickup **Listings** exclusively, not general shipped **Listings**.
6. **Price Filter vs. Sort Asymmetry:** `filter=price` checks base price only, whereas `sort=price` ranks by base price plus shipping.
7. **Multi-Variation Grouping & 10,000-Match Cap:** Variation **Listings** return summary groups rather than individual sizes, and deep pagination stops at 10,000 **Listings**.
8. **Watchlist Persistence Policy Check:** Avoid persisting full seller PII locally; store minimal **Saved Search** definitions and **Watchlist** references (`itemId`, `itemWebUrl`) and verify compliance against eBay's exemption form and API License Agreement.

---

## Primary & Supporting References

- **eBay Developers Program Portal:** https://developer.ebay.com/
- **API Deprecation Status (Finding/Shopping retirement Feb 5, 2025):** https://developer.ebay.com/develop/apis/api-deprecation-status
- **Legacy APIs Migration Paths:** https://developer.ebay.com/support/rest-api-migration
- **Buy APIs Overview:** https://developer.ebay.com/api-docs/buy/static/buy-apis-overview.html
- **Browse API Overview:** https://developer.ebay.com/api-docs/buy/browse/overview.html
- **Browse API Methods:** https://developer.ebay.com/api-docs/buy/browse/resources/methods
- **Browse API `item_summary/search` Reference:** https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search
- **Buy API Field Filters Reference:** https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html
- **Feed API Overview:** https://developer.ebay.com/api-docs/buy/feed/overview.html
- **Marketplace Insights API Overview:** https://developer.ebay.com/api-docs/buy/marketplace-insights/overview.html

*(Note: Subpage details for OAuth token expiry `7200`, Developer Analytics `getRateLimits`, Marketplace Account Deletion Exemption steps, Taxonomy `getItemAspectsForCategory`, Metadata `getItemConditionPolicies`, and numeric Condition ID definitions were retrieved via Google Search grounding against `developer.ebay.com` where grounding returned redirect URLs rather than canonical deep-link URLs; exact deep URL paths for those subpages are intentionally omitted rather than inferred.)*
