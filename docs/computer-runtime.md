# Docker computer runtime

The API and worker run Pi sessions and call provider-neutral computer tools. The Docker supervisor manages a Linux desktop container; no model runtime is installed inside that container.

```text
Web → API / worker → Pi tools → Docker supervisor → Linux desktop
```

A model must support image tool results to operate screenshots. Shell and file tools remain available independently of graphical tools.

## Team and Dedicated computers

Team computers share a persistent workspace. Each bot has an independent display, browser profile, and screen lease. Dedicated computers keep a bot's state separate. Browser profiles live under `.browser-profiles`; bot folders live under `bots/`. Deleting a bot removes its own state without following symlinks into another bot's folders. Stopped computers apply deferred cleanup on their next start.

A display slot has separate view and control capabilities. Revocation disconnects clients before a slot is reused, so an old screen connection cannot control another bot. Display limits can reject a new graphical session while shell and file tools remain usable. Idle, uncontrolled displays can be reclaimed for active bots. Closing a viewer does not delete its profile.

## Boundaries

The supervisor alone holds the Docker socket. Keep it on the internal network with a dedicated `SANDBOX_SUPERVISOR_TOKEN`. Computers mount only their own workspace subdirectory. Commands and terminals run as the workspace user rather than root.

View and control URLs pass through an encrypted capability proxy. Short-lived capabilities bind the computer, display, and access mode. Provider credentials never appear in browser-visible screen URLs. A failed teardown keeps its slot reserved for retry.

A Team computer lease is scoped to the bot and run; Dedicated computers serialize screen use. Lease fences prevent a stale worker from resuming control after another run has acquired the computer. Takeover and background operations use the same authorization boundaries.

## Workspace persistence

The portable workspace is the durable boundary. Docker mounts its home directly and advances the checkpoint revision at completion, failure, explicit stop, and idle suspension. Replacement machines restore the saved workspace before use. System packages outside the workspace are not portable.

`LocalAgentHomeStore` stores homes under `DATA_DIR/homes` and revision metadata under `DATA_DIR/home-revisions`. Replacement writes are staged before swapping the current copy, and checkpoints are serialized per computer. Put `DATA_DIR` on persistent storage, encrypt the host volume when required, and include it in backups.

## Configuration and networking

Use `SANDBOX_PROVIDER=docker` for local computers or `none` to run without computers. `fake` is reserved for offline tests. Set the computer image, resource limits, idle lifetime, and display limits using the documented settings in `.env.example`.

The source and images Compose stacks include a supervisor. The production HTTPS stack needs the Docker overlay described in [self-hosting](./self-host.md). Computers should not reach the host, LAN, or cloud metadata endpoints; see the restricted-egress script in that guide.

The web screen frame is sandboxed. Connection failures show a retry action instead of leaving a blank screen. Terminals use the shared shell environment and are available only to an authorized screen capability.

## Computer maintenance

Computer updates and recovery run as durable background jobs. A computer-wide reservation excludes new leases, takeover, stop, idle suspension, and computer-mode changes while the operation saves and replaces its workspace. The web UI restores active operations and failures from the API when reopened.

An update rebuilds with the configured image; it does not discover image releases. Recovery can use the last saved workspace, so unsaved work may be lost. The reconciler republishes queued operations after missed enqueue events. A stale worker heartbeat alone never authorizes destructive takeover.

If a worker disappears during maintenance, stop the affected workers and verify that provider operations have stopped before using the deployment-owner **Release computer** action. It requires explicit confirmation and accepts only interrupted operations in the current Space. Progress records actual lifecycle stages.

## Verification

Unit and integration tests use deterministic local fakes by default. They cover screenshots, actions, provider contracts, workspace transfer, screen isolation, profile persistence, symlink boundaries, and lease fencing without model or sandbox network calls.

The supervisor's opt-in Docker tests run isolated containers with local fixture sites. For example:

```bash
pnpm sandbox:build
VERIFY_DOCKER_TEAM_SCREENS=1 pnpm exec vitest run infra/sandboxes/supervisor/src/team-desktops.docker.test.ts
```

This verifies independent cookies and desktops, profile persistence, transport teardown, and rejection of stale capabilities after slot reuse.
