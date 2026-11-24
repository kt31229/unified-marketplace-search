# Local Environment Gotchas

Non-obvious constraints for agents running in this Windows workspace.

## Worktrees and `node_modules`

- Run `npm ci` inside each new worktree (`Workspace: "share"` or `git worktree add`).
- Never link `node_modules` with `mklink /J` on Windows: worktree cleanup follows junctions and deletes the parent workspace's `node_modules`.

## Windows Sandbox Boundaries

- Run `npm run check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and read-only `git` commands inside the standard sandbox (`BypassSandbox: false`).
- Keep `BypassSandbox: true` limited to single, unchained commands that require host/network access: `git` write operations (`checkout`, `commit`, `merge`, `fetch`, `push`), `gh`, and `npm ci` / `npm install`.

## Testing and Live Smoke Boundaries

- `npm test` is strictly offline and deterministic; `tests/setup.ts` blocks non-loopback `fetch` calls and real `patchright` browser launches.
- Run live marketplace checks via `npm run smoke:live` with `UMS_DATA_DIR` pointed at a temporary directory so user profiles and SQLite state stay untouched.

## Subagent Reviews

- Default read-only diff reviewers (such as `/code-review` subagents) to `Model: "flash"` to avoid `429 RESOURCE_EXHAUSTED` stalls when running parallel reviews.
