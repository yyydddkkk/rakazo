import type { AdapterContext, ConnectorEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type * as db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposioConnector, isComposioEnabled } from "./composio-connector.js";
import { FakeComposioClient } from "./composio-fake.js";
import { connectApp } from "./connect-app.js";
import { createConnectorStack } from "./connector-registry.js";

const stored = vi.hoisted(() => [] as { blocks: MessageBlock[]; clientNonce: string }[]);
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  createThreadMessageInTransaction: vi.fn(async (_tx, input) => {
    stored.push(input);
    return { id: "card" };
  }),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
}));

const context: AdapterContext = {
  spaceId: "space",
  userId: "user",
  botId: "bot",
  operationId: "chain",
  traceId: "chain",
  signal: new AbortController().signal,
};
const target = { id: "run", spaceId: "space", botId: "bot", threadId: "chat" };

type Row = { spaceId: string; connectorId: string; provider: string; status: string };

/** Connection rows are per Space; the fake client below reports accounts per user. */
function cardDeps(rows: Row[] = []) {
  const tx = {
    $executeRaw: vi.fn(),
    message: {
      findMany: vi.fn(async () => stored),
      findFirst: vi.fn(
        async ({ where }: { where: { clientNonce: string } }) =>
          stored.find((message) => message.clientNonce === where.clientNonce) ?? null,
      ),
    },
  };
  return {
    prisma: {
      $transaction: vi.fn(async (fn) => fn(tx)),
      connection: {
        findMany: vi.fn(async ({ where }: { where: { spaceId: string; status: string } }) =>
          rows.filter((row) => row.spaceId === where.spaceId && row.status === where.status),
        ),
      },
    },
    events: { notify: vi.fn() },
  } as unknown as Parameters<typeof connectApp>[0];
}

async function collect(events: AsyncIterable<ConnectorEvent>) {
  const out: ConnectorEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

beforeEach(() => {
  stored.length = 0;
});

describe("without COMPOSIO_API_KEY", () => {
  it("does not enable Composio for a missing or blank key", () => {
    expect(isComposioEnabled(undefined)).toBe(false);
    expect(isComposioEnabled("")).toBe(false);
    // Offline tests never reach the real service, even with a key in the environment.
    expect(isComposioEnabled("fake-key")).toBe(false);
  });

  it("registers no managed provider, so connect_app finds no app and posts no card", async () => {
    const { connector } = createConnectorStack([]);
    expect(connector.managedProviders()).toEqual([]);
    expect(connector.managed("composio")).toBeUndefined();

    const result = await connectApp(
      cardDeps(),
      connector.managedProviders(),
      context,
      target,
      "gmail",
      "effect",
    );
    expect(result).toEqual({ error: "No such app is available in the connector catalog." });
    expect(stored).toEqual([]);
    await expect(connector.discoverTools(context)).resolves.toEqual([]);
    await expect(
      collect(
        connector.execute({ tool: "GMAIL_FETCH_EMAILS", args: {}, executionId: "x" }, context),
      ),
    ).resolves.toEqual([{ type: "error", message: "unknown connector composio" }]);
  });
});

describe("with a Composio connector over the fake client", () => {
  it("runs catalog, connect card, authorization, discovery and execution through the registry", async () => {
    const composio = new ComposioConnector({ client: new FakeComposioClient() });
    const { connector } = createConnectorStack([composio]);
    expect(connector.managedProviders()).toEqual([composio]);

    const catalog = await composio.catalog(context, "gmail");
    expect(catalog).toEqual([expect.objectContaining({ slug: "GMAIL", connected: false })]);

    // connect_app posts a card built from the catalog entry.
    const rows: Row[] = [];
    const deps = cardDeps(rows);
    const pending = await connectApp(
      deps,
      connector.managedProviders(),
      context,
      target,
      "gmail",
      "effect",
    );
    expect(pending).toMatchObject({ status: "pending" });
    const card = stored[0]?.blocks[0];
    expect(card).toMatchObject({
      kind: "app_connect",
      connectorId: "composio",
      provider: "GMAIL",
      status: "pending",
    });

    // The user clicks Connect: begin, then the OAuth return completes the connection.
    const provider = (card as { provider: string }).provider;
    const started = await connector
      .managed("composio")!
      .begin({ provider, redirectUrl: "https://rakazo.example.test/app" }, context);
    expect(started.state).toMatch(/^ca_/);
    await composio.complete({ state: started.state, code: "" }, context);
    await expect(composio.connectionReady(context, provider)).resolves.toBe(true);
    await expect(composio.listConnectedExternalIds(context)).resolves.toEqual(["GMAIL"]);
    rows.push({ spaceId: "space", connectorId: "composio", provider, status: "connected" });

    // Once connected, connect_app reports it instead of posting another card.
    await expect(
      connectApp(deps, connector.managedProviders(), context, target, "gmail", "again"),
    ).resolves.toMatchObject({ status: "connected" });
    expect(stored).toHaveLength(1);

    // The connected app's tools are discovered and routed back to Composio.
    const connected: AdapterContext = {
      ...context,
      connectedConnections: [
        {
          id: "connection-gmail",
          connectorId: "composio",
          externalId: provider,
          displayName: "Gmail",
          providerRef: started.state,
        },
      ],
    };
    const tools = await connector.discoverTools(connected);
    const fetchTool = tools.find((tool) => tool.name === "GMAIL_FETCH_EMAILS");
    expect(fetchTool?.route).toMatchObject({ connectorId: "composio" });

    const events = await collect(
      connector.execute(
        { tool: fetchTool!.name, args: {}, executionId: "fetch", route: fetchTool!.route },
        connected,
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: "result" });
  });
});

describe("one user across two Spaces", () => {
  it("shows the connect card in a Space that has no row for an account the user already holds", async () => {
    const composio = new ComposioConnector({ client: new FakeComposioClient() });
    const providers = createConnectorStack([composio]).connector.managedProviders();
    const spaceB = { ...context, spaceId: "space-b" };
    const targetB = { ...target, spaceId: "space-b", threadId: "chat-b" };
    const rows: Row[] = [];
    const deps = cardDeps(rows);

    // The user connects GitHub from Space A: the provider account is the user's.
    const started = await composio.begin(
      { provider: "GITHUB", redirectUrl: "https://rakazo.example.test/app" },
      context,
    );
    await composio.complete({ state: started.state, code: "" }, context);
    rows.push({
      spaceId: "space",
      connectorId: "composio",
      provider: "GITHUB",
      status: "connected",
    });
    expect((await composio.catalog(spaceB, "github"))[0]).toMatchObject({ connected: true });

    await expect(
      connectApp(deps, providers, context, target, "github", "a"),
    ).resolves.toMatchObject({ status: "connected" });
    await expect(
      connectApp(deps, providers, spaceB, targetB, "github", "b"),
    ).resolves.toMatchObject({ status: "pending" });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.blocks[0]).toMatchObject({ provider: "GITHUB", status: "pending" });

    // Connecting in Space B adds its own row; both Spaces now report connected.
    rows.push({
      spaceId: "space-b",
      connectorId: "composio",
      provider: "GITHUB",
      status: "connected",
    });
    await expect(
      connectApp(deps, providers, spaceB, targetB, "github", "c"),
    ).resolves.toMatchObject({ status: "connected" });
  });
});
