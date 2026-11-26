# Coding Standards

Judgement rules for code review. Mechanical formatting, unused imports, and type checks are enforced by `npm run lint` and `npm run typecheck`.

## Domain Vocabulary (`GLOSSARY.md`)

- Enforce all canonical terms and `_Avoid_` lists defined in `GLOSSARY.md` across UI copy, domain types, API payloads, tests, and docs.

## Architecture Alignment (`docs/adr/`)

- Check changes against all accepted ADRs in `docs/adr/`.
- Flag any contradiction explicitly rather than letting silent architectural drift land.

## Privacy and Security Boundaries

- Never persist raw eBay `seller` objects or seller PII in SQLite, logs, or API responses.
- Never return raw `client_secret` from `GET /api/settings` or write secrets into logs.
- Keep the HTTP server bound strictly to `127.0.0.1` (loopback only).

## Deterministic Test Boundaries

- Inject or mock `fetch` and `BrowserTransport` in unit and integration tests instead of calling live Marketplaces or launching real browsers.
