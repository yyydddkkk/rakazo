# Contributing to Rakazo

Rakazo is a single-user, web-only self-hosted product. Keep changes focused and testable.

## Run locally

Follow the [source checkout setup](README.md#local-development-source-checkout) for prerequisites,
required secrets, and startup commands.

## Checks before you open a PR

| Command | When to run |
| --- | --- |
| `pnpm test` | Default. Units, properties, and in-process contracts. Scripted runtime, fake sandbox, in-memory wakeup — no live connector or model-provider calls. |
| `pnpm test:integration` | Postgres via Testcontainers: product journeys, authorization, executor lifecycle, Graphile / LISTEN/NOTIFY. Needs Docker. |
| `pnpm test:e2e` | Playwright against the emulated API. Needs Docker. |
| `pnpm test:pi` | Real Pi against a local HTTP model fixture: streaming, tool round trips, failures and cancellation. No keys. |
| `pnpm check` | TypeScript (`tsc`) across the monorepo. |
| `pnpm lint` | Biome lint and format check. |

CI runs `pnpm lint`, `pnpm check`, production builds, `pnpm test`, `pnpm test:integration`, and `pnpm test:e2e` on every PR.

Ordinary test processes (`NODE_ENV=test`) do not load the checkout's `.env`.
Verification CLIs load configuration before starting isolated test processes;
live canaries explicitly enabled with `VERIFY_PROVIDERS` also opt into loading it.

## Adding a UI language

The web UI uses Lingui catalogs. To add a locale, register it in
`apps/web/lingui.config.ts`, `apps/web/src/lib/ui-locale.ts`, and
`apps/web/src/lib/i18n.ts`, then run `pnpm --filter @rakazo/web intl:extract`, fill the new
`apps/web/src/locales/<locale>/messages.po` catalog, and validate it with
`pnpm --filter @rakazo/web intl:compile`. Keep message IDs, placeholders, JSX markers, and
ICU plural branches intact; do not commit generated `*.js`/`*.mjs` catalog files.

Update the locale unit tests and the relevant web UI E2E scenario when changing a supported locale.
The slim distribution supports English and Simplified Chinese.

## Secrets and configuration

- **Never** commit `.env` files or secrets.
- **Never** paste API keys, tokens, or passwords in issues or PRs.
- Use placeholders in examples (`your-openrouter-key`, etc.).

The product path is **Pi + Docker + Graphile**. Emulator settings (`AGENT_RUNTIME=scripted`, `SANDBOX_PROVIDER=fake`, `WAKEUP_DRIVER=memory`) are for tests only.

**Integrations** use HTTPS MCP servers (including Treg) and bounded OpenAPI tool sources.
Connector tests must stay deterministic and offline. Keep credentials in the encrypted secret
store and use fake placeholders in fixtures, logs, and snapshots.

## Pull requests

- Keep PRs small and easy to review.
- Target the `main` branch.
- Describe why the change is needed, what changed, and **how you tested** (e.g. `pnpm test`, manual steps).
- Link related issues when applicable.
