# Vision

Rakazo is a single-user, web-only self-hosted agent factory.
Define, generate, run, observe, and orchestrate persistent agents while retaining control of their data, state, models, and infrastructure.

## Bots are persistent agents

A bot has a durable identity, instructions, conversation, memory, routines, and working state.
Bots can be created for distinct roles, organized into fleets and groups, and coordinated through messages, handoffs, and child agents.
The factory makes a growing collection of agents manageable: the operator can see what is running, inspect results, and intervene when needed.
Useful work lands in its intended destination and remains verifiable beyond a single chat.

## Spaces isolate agent clusters

One user owns one Organization and can create several Spaces.
Each Space is a data and authorization boundary for its agent cluster, conversations, files, memory, computers, and integrations.
Collaboration within a Space does not implicitly grant access across Spaces.
Shared computers support collaboration; private computers provide stronger separation when a bot's work requires it.

## Executors and workflows are replaceable

Pi and the experimental Oh My Pi (omp) implement the shared AgentRuntime contract.
Rakazo owns durable product state, orchestration, and product tools; executors supply their agent loop and native capabilities.
Product tools follow Rakazo approval policy. Executor-native tools may intentionally execute outside that policy, with their host permissions and isolation boundaries made explicit.
Secrets remain protected in every executor's logs, events, and persisted state.

Skills, plugins, and reusable prompt or plugin stacks such as pstack should let operators adopt and adapt other people's workflows.
Compatibility is verified per executor rather than assumed across all stacks.
Cloud execution and cluster control are long-term goals, built on the same durable bot identities and replaceable execution boundaries.

## Ownership includes choice

The complete core product runs on infrastructure controlled by its operator under an open-source license.
No hosted vendor is required for models, computers, memory, integrations, or another core workflow.
External services remain optional behind provider-neutral interfaces; new providers reuse shared contracts and deterministic offline conformance tests.
Bot data and state remain inspectable, exportable, recoverable, and portable across provider failure or replacement.

## Web is the only frontend

The operator works through the web UI; integrations connect to shared product contracts.
Frontends express intent and render state while shared packages and the backend own orchestration, authorization, validation, retries, recovery, and provider translation.
The interface shows useful progress, results, and requests for help. Advanced controls appear when relevant, and copy stays minimal.
A pending question or approval card remains answerable without preventing the user from chatting or starting other work.

## Trust and scope

Authentication, secret handling, sandbox boundaries, host commands, and integrations are security-sensitive product behavior.
Important effects are verified independently, recovery preserves known-good state, and core tests remain deterministic and offline by default.
A trusted host or third-party destination is not isolated from data deliberately sent to it.

Rakazo is not a model provider, a hosted-only service, or a general virtual-machine manager.
Changes should strengthen persistent agent work, reusable workflows, orchestration, user ownership, or safe collaboration while preserving explicit boundaries.
This file records current product direction; implementation plans explain mechanics, and Git history preserves superseded decisions.
