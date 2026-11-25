# Unified Marketplace Search

A local-first personal search aggregator that queries multiple secondhand resale Marketplaces simultaneously and presents matching Listings in one interface.

## Language

**Marketplace**:
A secondhand resale venue queried by the app (e.g., eBay, Poshmark, Mercari, Facebook Marketplace).
_Avoid_: Source, platform, site

**Listing**:
A single secondhand posting returned by a Marketplace, including its title, price, thumbnail, and direct link.
_Avoid_: Item, product, post, result

**Unified Filter**:
A user-facing search constraint expressed in the app's common schema (such as price range, condition, fulfillment, or location).
_Avoid_: Global filter, shared filter

**Marketplace Filter**:
A Marketplace-specific search input that a Unified Filter translates into when querying that Marketplace.
_Avoid_: Source parameter, native parameter, vendor param, platform filter

**Saved Search**:
A stored combination of search terms, Unified Filters, and selected Marketplaces that can be re-run on demand.
_Avoid_: Search preset, alert, saved query

**Watchlist**:
A single flat list of bookmarked Listings saved for later review.
_Avoid_: Favorites, bookmarks

**Watchlist Entry**:
A frozen snapshot of a Listing saved to the Watchlist, including its title, price, thumbnail, direct link, and saved timestamp.
_Avoid_: Saved listing, favorite, bookmark, watched item

**Facebook City Hub**:
A configured regional Facebook Marketplace city endpoint queried sequentially as part of a nationwide sweep.
_Avoid_: Hub query, city query, location hub
