# Docker computers

`SANDBOX_PROVIDER=docker` runs bot computers through the in-stack supervisor.
Bots share a persistent Team Computer by default; Dedicated computers keep their working state
separate. Both modes retain browser profiles, independent displays and control leases.

The source and images Compose stacks include the supervisor. For the production HTTPS stack,
layer `infra/compose/docker-compose.prod.docker.yml` after `docker-compose.prod.yml` in every
Compose command. The base production file alone uses `none` because it has no supervisor.

## Configuration

- Set `SANDBOX_SUPERVISOR_TOKEN` to a dedicated random credential.
- Give the supervisor access to Docker Engine through its socket.
- Build or configure the computer image with `RAKAZO_COMPUTER_IMAGE` and its tag.
- Keep the supervisor on the internal network; expose only the web UI through HTTPS.

For a source checkout, build the image with `pnpm sandbox:build`.
A computer starts when a bot first needs it. Idle computers stop after `SANDBOX_IDLE_MS`;
portable working state and browser profiles remain available on the next start.

See [self-hosting](./self-host.md) for resource limits, restricted egress and deployment commands.

## Without computers

`SANDBOX_PROVIDER=none` starts the web UI, API and worker without provisioning computers.
The `fake` provider is retained for deterministic offline tests.
