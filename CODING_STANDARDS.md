# Coding Standards

Judgement rules for code review. Mechanical formatting, unused imports, and type checks are enforced by `npm run lint` and `npm run typecheck`.

## Domain Vocabulary (`GLOSSARY.md`)

- Use canonical terms across UI copy, domain types, API payloads, tests, and docs: **Marketplace**, **Listing**, **Unified Filter**, **Marketplace Filter**, **Saved Search**, **Watchlist**, **Watchlist Entry**.
- Flag avoided synonyms (`source`, `platform`, `site`, `item`, `product`, `post`, `result`, `preset`, `favorites`, `bookmarks`) when they name domain concepts.

## Architecture Alignment (`docs/adr/`)

- Check changes against accepted ADRs (`docs/adr/0001`–`0005`).
- Flag any contradiction explicitly rather than letting silent architectural drift land.

## Privacy and Security Boundaries

- Never persist raw eBay `seller` objects or seller PII in SQLite, logs, or API responses.
- Never return raw `client_secret` from `GET /api/settings` or write secrets into logs.
- Keep the HTTP server bound strictly to `127.0.0.1` (loopback only).

## Deterministic Test Boundaries

- Inject or mock `fetch` and `BrowserTransport` in unit and integration tests instead of calling live Marketplaces or launching real browsers.
