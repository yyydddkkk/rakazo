# Set up single-user Rakazo with a coding agent

## Local source checkout (pnpm)

Use this for the web UI, API, worker, and Docker computers from a source checkout.

```text
Set up Rakazo locally and leave it running in a usable state.

Use the current slim/web-only checkout or the operator-provided fork URL.

Work like a careful onboarding engineer: perform the setup yourself, explain only decisions or blockers, and verify the product through the UI rather than stopping after dependency installation.

Safety rules:

- Never overwrite an existing `.env`. If one exists, inspect only which keys are present (never print values), preserve it, and ask before changing existing values.
- Never print, log, commit, or paste secrets into tracked files. Confirm `.env` is ignored. Do not commit anything as part of setup.
- Do not discard local changes if the repository already exists. Inspect `git status` first.
- Do not kill unrelated processes or containers to free ports. Identify conflicts and ask before stopping anything; otherwise use a safe alternate configuration and document it.
- Treat Docker host access and model or integration credentials as security-sensitive.

Before making changes, ask me these concise questions:

1. Should you clone into the current directory, or what parent directory should contain `rakazo`? If you are already inside a Rakazo checkout, offer to use it without recloning.
2. How should models be connected?
   - Add a deployment-wide `OPENROUTER_API_KEY` to `.env`.
   - Connect during Rakazo onboarding with a provider API key or with ChatGPT Plus/Pro, GitHub Copilot, or SuperGrok / X Premium.
   - Defer model setup and verify infrastructure only. Make clear that bots cannot answer until a model is connected.
3. What admin email should initialize this single-user instance? Enter the initial admin password directly into `.env` without printing it. Set `RAKAZO_ADMIN_EMAIL` and `RAKAZO_ADMIN_PASSWORD`; sign in with this account instead of registering a new user.

Generate the required application secrets with openssl; do not ask me to invent them. If I choose an API key, let me enter it through an available secure secret mechanism or directly into `.env`; never echo it back. OAuth or device-code sign-in must remain under my control.

Preflight:

- Verify Git, Node.js, pnpm, Docker, and Docker Compose.
- Use a Node.js version supported by `engines.node` and the pnpm version declared in `packageManager` in the root `package.json`. Prefer Corepack; if unavailable, use `npx --yes pnpm@<declared-version>` instead of globally installing a different version. Use that same executable for every later `pnpm` command, including verification and restart commands. Show the effective versions.
- Verify the Docker daemon is running.
- Check whether `127.0.0.1` ports 5433 (only if using the optional postgres-host overlay), 3100, 5173, and 7091 are available. Resolve conflicts without touching unrelated workloads.
- Ensure `.env` sets non-empty `POSTGRES_PASSWORD` (owner, migrations) and `POSTGRES_APP_PASSWORD` (the app's `rakazo_app` login). When using the optional postgres-host overlay (or any host-side database URL), `DATABASE_MIGRATION_URL` must use `POSTGRES_PASSWORD` and `DATABASE_URL` must use `rakazo_app` with `POSTGRES_APP_PASSWORD`.

Setup:

1. Clone the repository if needed and enter its root.
2. Read `AGENTS.md`, `README.md`, `.env.example`, and the root `package.json` before acting. Follow repository instructions if they have changed since this prompt was written.
3. If `.env` does not exist, copy `.env.example` to `.env`. In a new file, generate `POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD` independently with `openssl rand -hex 16`, and put them into host-side `DATABASE_MIGRATION_URL` and `DATABASE_URL` respectively (replace the placeholder passwords). For an existing file without `POSTGRES_APP_PASSWORD`, generate it and point host-side `DATABASE_URL` at `rakazo_app` with it, and `DATABASE_MIGRATION_URL` at the owner; `pnpm db:migrate` creates that login. Also generate `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`, and `SANDBOX_SUPERVISOR_TOKEN` independently with `openssl rand -hex 32` (64 hex characters each). For an existing file, check those keys without printing values and generate only absent non-Postgres secrets. For `POSTGRES_PASSWORD` and host-side `DATABASE_MIGRATION_URL` (when present / when the postgres-host overlay will be used), compare the password parts without printing them and require one confirmed shared password written to both settings. First check whether the Compose `pgdata` volume already exists (for example `docker volume ls` for the project postgres volume). If `pgdata` is absent, generate one URI-safe password with `openssl rand -hex 16` and write it to both `POSTGRES_PASSWORD` and host-side `DATABASE_MIGRATION_URL`. If `pgdata` exists and either credential is missing or they disagree, ask which password that volume already uses and set both to that first-init value. Do not generate a new `POSTGRES_PASSWORD` when `pgdata` already exists unless I explicitly confirm in-place `ALTER ROLE` or a disposable `pgdata` recreate (backup first; `docker compose down -v` deletes all Postgres state); otherwise preserve the working credentials so `pnpm db:migrate` keeps authenticating. Preserve other existing values; if a required non-Postgres value is empty, ask before replacing it. Keep local defaults for Postgres user/db, origins, Pi, Docker, and Graphile unless the preflight found a conflict. Add only the model credentials I selected. Leave optional credentials blank.
4. Confirm `.env` is ignored and that no secret-bearing file is staged.
5. Start only local Postgres with the base Compose file (Postgres stays network-internal; no host publish):

   `docker compose --env-file .env -f infra/compose/docker-compose.yml up postgres -d`

   The `infra/compose/docker-compose.postgres-host.yml` overlay is optional: add it only when host-side DB access is needed (`pnpm db:migrate`, GUI tools), so loopback `127.0.0.1:5433` is published, and keep host-side `DATABASE_MIGRATION_URL` on `POSTGRES_PASSWORD` and `DATABASE_URL` on `POSTGRES_APP_PASSWORD`. Without the overlay, use `docker compose --env-file .env -f infra/compose/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'` for one-off SQL.

6. With the repository-declared pnpm version, run:

   `pnpm install --frozen-lockfile`
   `pnpm db:generate`

   For host-side `pnpm db:migrate`, ensure Postgres is up with the optional postgres-host overlay (same volume) and that `DATABASE_MIGRATION_URL` matches `POSTGRES_PASSWORD`, then run:

   `pnpm db:migrate`
   `pnpm sandbox:build`

   The first sandbox build may take several minutes because it installs a graphical Linux desktop and Chromium. If a command fails, diagnose the cause; do not bypass the lockfile or approve arbitrary dependency build scripts just to make progress.

7. Start `pnpm dev` in a persistent terminal. Wait until the API, worker, web app, and sandbox supervisor are ready. Keep the process running for me.

Verification:

- Request `http://127.0.0.1:3100/internal/health`. Require `ok: true`, `runtime: "pi"`, `sandbox: "docker"`, `jobs: "graphile"`, and `realtime: "postgres"`. `revision` is `null` unless `GIT_SHA` is set.
- Open `http://127.0.0.1:5173` in a browser. If browser automation is available, use it for non-sensitive steps; otherwise give me the exact UI steps.
- Sign in with the configured admin account, complete model setup, and create a test bot. Do not create additional users.
- If a model is connected, send a harmless test message and confirm the bot replies. If model setup was deferred, explicitly report that the stack is healthy but a first message will fail until a provider is configured; do not call the setup fully usable without that caveat.
- Open the Agent computer pane and confirm the Docker computer reaches `running` and renders its desktop.
- Open Integrations and verify that HTTPS MCP and OpenAPI sources are available.
- Run `pnpm test`, `pnpm check`, and `pnpm lint`. Report failures; do not claim success if any fails.

When finished, report:

- The absolute repository path and checked-out commit.
- Effective Node, pnpm, Docker, and Docker Compose versions.
- Which model-auth path and optional integrations are configured, without revealing secrets.
- App URL, health result, UI/message/computer verification, and test/type-check results.
- Every workaround or remaining limitation.
- How to restart the stack.
- How to stop it without deleting data. Do not use `pnpm compose:down` for a normal stop because that script includes `-v` and removes Compose volumes; use a non-destructive stop/down command without `-v` and explain it.
```
