# Rakazo

Rakazo is a single-user, web-only self-hosted home for persistent AI teammates.
Run the API, worker, web UI, PostgreSQL, and Docker computers on infrastructure you control.
Connect your own models through Pi; external services remain optional.

## Features

- Persistent bots, built-in memory, and scheduled routines
- Team and Dedicated Docker computers, browser profiles, multiple displays, and user takeover
- Browser, terminal, file, and graphical desktop access
- Group chats, peer messages, and collaboration between bots
- Board and tickets, artifacts, Teach, avatar studio, and approval rules
- MCP and OpenAPI tool sources, Lark messaging, and external conversations
- Cursor Cloud Agent, media generation, and web search

## Stack

TypeScript, React, Vite, Tailwind CSS, Hono, oRPC, PostgreSQL, Prisma, Better Auth,
Graphile Worker, Pi, and Docker.

## Local development (source checkout)

You need Node.js 22.22.2 or newer in the 22.x line, Node.js 24.x, or Node.js 26+;
pnpm 9; and Docker. Node.js 23.x and 25.x are not supported.

```bash
# Clone your slim/web-only fork, then enter the checkout.
cd rakazo
cp .env.example .env
```

Set `POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD` to two values from `openssl rand -hex 16`,
then put them in `DATABASE_MIGRATION_URL` and `DATABASE_URL`. The app connects as its own
`rakazo_app` login, which row-level security applies to; migrations run as the owner
([database roles](docs/self-host.md#database-roles)). Set `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` to
independent long random values. Docker sandboxes also need a dedicated
`SANDBOX_SUPERVISOR_TOKEN`. You can also set `OPENROUTER_API_KEY`, or connect a supported
model provider during onboarding.
Set `RAKAZO_ADMIN_EMAIL` and replace the `RAKAZO_ADMIN_PASSWORD` placeholder before the first start.

For host-side development with Docker Desktop, set `SANDBOX_CONTROL_VIA_LOOPBACK=true`
in `.env`. The supervisor discovers Docker Desktop's user socket automatically;
`DOCKER_HOST` or `DOCKER_SOCKET` can override it for another Docker runtime.

Add HTTPS MCP servers or OpenAPI tool sources from **Integrations**. Connector credentials
are encrypted on the server and are never returned by the API.

```bash
docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.postgres-host.yml \
  up postgres -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev
```

Postgres stays network-internal in the default Compose file (same as published images). The
`postgres-host` overlay publishes loopback `127.0.0.1:5433` for host-side `pnpm` and DB tools.
If that port is occupied, change `POSTGRES_HOST_PORT` and the ports in `DATABASE_URL` and
`DATABASE_MIGRATION_URL` in `.env`.
Without the overlay, open a shell with
`docker compose --env-file .env -f infra/compose/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`.
Use a URI-safe `POSTGRES_PASSWORD` (`openssl rand -hex 16`). An existing `pgdata` volume keeps the
user, password, and database from first init, so keep those values in `.env`, or change them in
place with `ALTER ROLE` / rename. Recreate the volume only after a backup (or when the data is
disposable); `docker compose down -v` deletes all Postgres state.

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), sign in with the configured admin credentials,
connect a model, and create your first bot.

For deployment, provider selection, backups, and upgrades, see the
[self-hosting guide](./docs/self-host.md).

## Single-user deployment

The instance uses one administrator account and one Organization, with any number of Spaces the administrator creates. Configure
`RAKAZO_ADMIN_EMAIL` and `RAKAZO_ADMIN_PASSWORD` for initial setup; use placeholder values
only in tracked examples. A first start creates one default Space; each Space keeps its own bots, chats, computers, memory, models, app connections, and approval rules.
Use a browser to connect to the instance and put HTTPS in front of a public deployment.
See [self-hosting](./docs/self-host.md) for deployment, backups, and configuration.

## Development

```text
apps/       web, api, and worker
packages/   domain, contracts, persistence, adapters, UI, and test tooling
infra/      local services and Docker computer images
```

```bash
pnpm check
pnpm lint
pnpm test
pnpm test:integration
pnpm test:e2e
```

The default tests use deterministic offline fakes and emulators.
See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow.
For an agent-assisted source install, use [SETUP_PROMPT.md](./SETUP_PROMPT.md).

## Documentation

- [Self-hosting](./docs/self-host.md)
- [Self-host secrets](./docs/self-host-secrets.md)

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.
For vulnerabilities, follow [SECURITY.md](./SECURITY.md).

Rakazo is licensed under the [Apache License 2.0](./LICENSE).
