# Self-hosting Rakazo

Rakazo is a single-user web application. The administrator can keep several Spaces, each isolated from the others. The API, worker, Postgres, and web UI run on your infrastructure. Docker computers are optional; models, Cursor, Lark, search services, and remote tools are optional connections.

## Source checkout

Install Docker Engine with the Compose plugin, Node.js compatible with `package.json`, and pnpm. Copy `.env.example` to `.env` and fill its required credentials with independent random values. See [secrets](./self-host-secrets.md).

```bash
cp .env.example .env
# Edit .env before starting the services.
docker compose --env-file .env -f infra/compose/docker-compose.yml up -d --build --wait
```

Open http://127.0.0.1:5173. Set `RAKAZO_ADMIN_EMAIL` and `RAKAZO_ADMIN_PASSWORD` before startup to bootstrap the local account. Store these values outside version control.

The source stack includes the Docker supervisor and computer image. The supervisor alone holds the Docker socket. API and worker use a separate database runtime login; the API uses the owner login for migrations and removes that URL before serving requests. Postgres is internal by default. The optional `docker-compose.postgres-host.yml` overlay exposes it on loopback for host development tools.

For host development, use the README setup and `pnpm dev`. On WSL, keep the checkout and data in the Linux filesystem and run as your normal user. If Docker Desktop container IPs are unreachable, use `SANDBOX_CONTROL_VIA_LOOPBACK=true` for a host-run supervisor.

## Database roles

`POSTGRES_PASSWORD` owns the migration login. `POSTGRES_APP_PASSWORD` belongs to the `rakazo_app` runtime login and row-level security remains enabled. Keep both credentials in the deployment environment; never expose the migration connection to worker processes.

## HTTPS deployment

Set `RAKAZO_HOST` to your hostname and set `BETTER_AUTH_URL`, `WEB_ORIGIN`, and `API_URL` to the same HTTPS origin. Point DNS at the server and allow inbound HTTPS. The Caddy configuration terminates TLS and proxies the web UI and API.

```bash
docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  up -d --build --wait --pull never
```

The base production file uses `SANDBOX_PROVIDER=none`. The Docker overlay enables local computers and adds the internal supervisor. Keep both files in subsequent Compose commands. Keep the supervisor and its token private.

## Existing images

`infra/compose/docker-compose.images.yml` is a pull-only stack for images you already have access to. Its app and computer image names and tags can be overridden with `RAKAZO_IMAGE`, `RAKAZO_IMAGE_TAG`, `RAKAZO_COMPUTER_IMAGE`, and `RAKAZO_COMPUTER_IMAGE_TAG`. Match the images to the source version you intend to deploy; this repository does not publish them automatically.

`infra/compose/install-images.sh` prepares that stack and generates missing credentials without replacing an existing `.env`. Use `--prepare-only` to review its files before startup. See [restricted networks](./self-host-restricted-network.md) for mirrors and local copies.

## Computers and memory

`SANDBOX_PROVIDER=docker` enables Docker computers; `none` runs without computers. `fake` is for deterministic tests. Team computers share persistent working state; Dedicated computers keep a bot's working state separate. Profiles, leases, and workspaces remain durable across idle shutdown. See [Docker computer configuration](./self-host-sandbox-providers.md) and [computer runtime](./computer-runtime.md).

Computer resource and idle limits are documented in `.env.example`. To restrict computer egress from host, LAN, and metadata endpoints, install `infra/compose/restrict-computer-egress.sh` on the host and configure `SANDBOX_COMPUTER_EGRESS=restricted`. Keep this protection enabled when host model credentials can reach a cloud metadata service. Run `pnpm test:compose-smoke` to verify the installer and egress configuration.

Memory is stored by the built-in Markdown memory store. Stored credentials use local encryption. `CONTENT_ENCRYPTION=on` encrypts new content at rest; existing encrypted content remains readable when the setting is off. Preserve the encryption keys across upgrades and backups. See [content encryption](./content-encryption.md) and [bot secrets](./bot-secrets.md).

## Optional connections

Connect a model through shared connection settings in the web UI. A deployment model can also use the generic `PI_DEFAULT_PROVIDER`, `PI_DEFAULT_MODEL`, and credential settings in `.env.example`. A host-authenticated model uses `PI_DEFAULT_CREDENTIALS=host` and its standard SDK credentials. Compatible endpoints use the shared OpenAI-compatible connection settings.

One-click app connections are optional. Set `COMPOSIO_API_KEY` on the API and worker (a project key from the Composio dashboard) and users can connect apps such as GitHub, Gmail, Slack, and Notion from Integrations or from the chat connect card. Authorization returns to `WEB_ORIGIN/app`; no callback URL needs to be registered in Composio. Leave the key blank and nothing about the product changes.

Remote tool sources use MCP or OpenAPI. Stdio MCP is opt-in with a command allowlist; remote endpoints are checked before credentials are sent. `MCP_ALLOW_PRIVATE_ENDPOINT=true` permits private endpoints when intentionally configured on your server.

Cursor is an optional coding agent; see [cloud agents](./self-host/cloud-agents.md). Lark is the optional direct-message transport. Configure its app ID, app secret, and verification token together. Email through SMTP is optional for password recovery. Auto Review uses the configured model by default, with an optional verifier adapter.

## Logs, backups, and updates

Logs stay local. Use `docker compose logs` and the `LOG_LEVEL` / `LOG_FORMAT` settings to inspect them. The Compose Caddy configuration writes structured access logs with credential headers and URL tokens redacted.

Back up Postgres, persistent application data, and encryption keys before upgrades. `scripts/backup.sh`, `scripts/restore.sh`, and `infra/systemd` provide backup and host-health utilities. Inspect their configuration before installing timers.

Update manually from a reviewed source revision, then rebuild and restart with the same Compose files. Migrations run before the API serves requests. Existing and new API processes may overlap briefly, so database migrations must remain compatible with the previous release. Check `/internal/health` and the web UI after startup. There is no updater sidecar.
