import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asSystem, formatMessagingLinkCode, issueMessagingLinkCode } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { FakeMessagingSurface } from "./fake-messaging.js";
import { fixtureAccountResponse } from "./fixture-account.js";
import { sessionCookieHeader } from "./index.js";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeMessaging = hasDb ? describe.sequential : describe.skip;

type App = { request: (input: string | Request, init?: RequestInit) => Promise<Response> };

// Offline journeys use only injected provider-neutral events and captured sends.
describeMessaging("messaging surface journeys", () => {
  let app: App;
  let stop: () => Promise<void>;
  let prisma: any;
  let handles: Awaited<ReturnType<typeof createApp>>;
  let cookie: string;
  let actor: { userId: string; spaceId: string };
  const transport = new FakeMessagingSurface();
  const platformAddress = "fixture-bot";
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-messaging-"));
  const stamp = Date.now();
  let addressSequence = 0;
  const uniqueAddress = () => `sender-${++addressSequence}`;
  const sender = uniqueAddress();
  const dmHandle = `journey-dm-${stamp}`;
  // Channels key on the opaque Chat SDK thread id, not the raw vendor group
  // id; derive expectations exactly as the production adapter encodes them.
  const groupThreadId = (groupId: string) => `fixture:group:${groupId}`;
  const dmThreadId = (address: string) => `fixture:dm:${address}`;
  function sentPosts() {
    return transport.sent.map((post) => ({
      ...post,
      kind: post.threadId.includes(":group:") ? "group" : "dm",
      groupId: post.threadId.split(":group:")[1],
      to: post.threadId.split(":dm:")[1],
    }));
  }
  async function receive(input: {
    from: string;
    content: string;
    handle?: string;
    groupId?: string;
    participants?: string[];
  }) {
    await transport.emitInbound({
      from: input.from,
      content: input.content,
      handle: input.handle,
      isDirect: !input.groupId,
      threadId: input.groupId ? groupThreadId(input.groupId) : dmThreadId(input.from),
      participants: input.participants?.filter((address) => address !== platformAddress) ?? [],
    });
  }
  const findIdentity = (address: string) =>
    prisma.messagingIdentity.findUnique({
      where: { provider_address: { provider: "fixture", address } },
    });

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      messaging: transport,
    });
    app = handles.app;
    stop = handles.stop;
    prisma = asSystem(handles.prisma);
    cookie = sessionCookieHeader(
      await fixtureAccountResponse(
        {
          body: JSON.stringify({
            email: "messaging@example.test",
            password: "password12",
            name: "Messaging",
          }),
        },
        handles.prisma,
      ),
    );
    const response = await app.request("/rpc/me", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ json: {} }),
    });
    actor = (await response.json()).json;
    await seedLinkedAddress(sender);
  });

  afterAll(async () => {
    await stop?.();
  });

  async function seedLinkedAddress(address: string) {
    const response = await app.request("/rpc/bots/create", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({
        json: { name: "Assistant", title: "", description: "", notifyOnFinish: true },
      }),
    });
    expect(response.status).toBe(200);
    const bot = (await response.json()).json;
    await discardBotIntroRun(handles, cookie, bot.id);
    return prisma.messagingIdentity.create({
      data: {
        provider: "fixture",
        address,
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId: bot.id,
      },
    });
  }

  it("runs a linked administrator bot and mirrors its reply back out", async () => {
    await receive({
      from: sender,
      content: "hello there",
      handle: dmHandle,
    });

    // Durable delivery runs asynchronously after inbound persistence.
    const identity = await waitForDatabase(async () => findIdentity(sender));
    // A non-null provider handle is the last durable signal of the whole
    // mirror loop (the claim flips status before the provider call lands).
    await waitForDatabase(async () =>
      Boolean(
        await prisma.messagingOutbound.findFirst({
          where: {
            identityId: identity.id,
            kind: "dm",
            status: "sent",
            providerHandle: { not: null },
          },
        }),
      ),
    );
    expect(sentPosts().some((send) => send.kind === "dm" && send.to === sender)).toBe(true);

    // The counter increments one statement after providerHandle lands, so
    // poll rather than racing the drain's last write.
    const refreshed = await waitForDatabase(async () => {
      const row = await findIdentity(sender);
      return row?.outboundSinceInbound === 1 ? row : null;
    });
    // The 1:1 conversation id is learned from the inbound webhook; outbound
    // DMs resolve through it instead of a provider lookup.
    expect(refreshed.dmThreadId).toBe(dmThreadId(sender));
    const outbound = await prisma.messagingOutbound.findMany({
      where: { identityId: identity.id, kind: "dm" },
    });
    expect(outbound).toHaveLength(1);
    expect(outbound[0].providerHandle).toBeTruthy();

    const userMessage = await prisma.message.findFirst({
      where: {
        threadId: (await prisma.thread.findFirst({ where: { botId: identity.botId } })).id,
        role: "user",
      },
    });
    expect(userMessage.clientNonce).toBe(`messaging:fixture:${dmHandle}`);
  });

  it("replays the same handle without a duplicate message or send", async () => {
    await receive({
      from: sender,
      content: "hello there",
      handle: dmHandle,
    });

    // Give any erroneous duplicate work a chance to appear.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const identity = await findIdentity(sender);
    const thread = await prisma.thread.findFirst({ where: { botId: identity.botId } });
    const userMessages = await prisma.message.findMany({
      where: { threadId: thread.id, role: "user" },
    });
    expect(userMessages).toHaveLength(1);
    const outbound = await prisma.messagingOutbound.findMany({
      where: { identityId: identity.id, kind: "dm" },
    });
    expect(outbound).toHaveLength(1);
    expect(sentPosts().filter((send) => send.kind === "dm" && send.to === sender)).toHaveLength(1);
  });

  it("runs the channel loop: discovery, invite, intro, YES, fan-out, attributed post", async () => {
    const stranger = uniqueAddress();
    const groupId = `grp-${stamp}`;
    const threadId = groupThreadId(groupId);

    // 1. Discovery: first group message creates the channel, invites the
    // linked sender, and posts one intro for the unlinked stranger.
    await receive({
      from: sender,
      content: "hey everyone",
      groupId,
      participants: [sender, stranger, platformAddress],
      handle: `grp-discover-${stamp}`,
    });

    await waitForDatabase(async () =>
      Boolean(
        await prisma.messagingOutbound.findFirst({
          where: { threadId, kind: "intro", status: "sent", providerHandle: { not: null } },
        }),
      ),
    );
    const channel = await prisma.messagingChannel.findUnique({ where: { threadId } });
    expect(channel).toBeTruthy();
    expect(channel.provider).toBe("fixture");
    const members = await prisma.messagingChannelMember.findMany({
      where: { channelId: channel.id },
      orderBy: { address: "asc" },
    });
    expect(members).toHaveLength(2);
    const senderMember = members.find((m: any) => m.address === sender);
    expect(senderMember.status).toBe("invited");
    expect(senderMember.identityId).toBeTruthy();
    const strangerMember = members.find((m: any) => m.address === stranger);
    expect(strangerMember.identityId).toBeNull();
    // invite DM went out to the sender, intro went to the group, both once
    expect(
      sentPosts().filter((send) => send.kind === "group" && send.groupId === groupId),
    ).toHaveLength(1);
    // the invited-only sender's message was not fanned out to any bot
    const identity = await findIdentity(sender);
    const runsBefore = await prisma.run.count({ where: { botId: identity.botId } });

    // 2. The owner approves by text command.
    await receive({
      from: sender,
      content: "YES",
      handle: `grp-yes-${stamp}`,
    });
    await waitForDatabase(async () => {
      const member = await prisma.messagingChannelMember.findUnique({
        where: { channelId_address: { channelId: channel.id, address: sender } },
      });
      return member?.status === "approved";
    });

    // 3. The next group message fans out to the approved bot, whose reply
    // is posted back to the group with attribution.
    await receive({
      from: sender,
      content: "what do you think?",
      groupId,
      participants: [sender, stranger, platformAddress],
      handle: `grp-second-${stamp}`,
    });

    await waitForDatabase(async () =>
      Boolean(
        await prisma.messagingOutbound.findFirst({
          where: { threadId, kind: "group", status: "sent", providerHandle: { not: null } },
        }),
      ),
    );
    const posts = await prisma.messagingOutbound.findMany({
      where: { threadId, kind: "group", status: "sent" },
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatch(/^Messaging's agent: /);
    expect(await prisma.run.count({ where: { botId: identity.botId } })).toBeGreaterThan(
      runsBefore,
    );
  });

  it("declines a channel invite on NO without waking the bot", async () => {
    const owner = uniqueAddress();
    await seedLinkedAddress(owner);
    const stranger = uniqueAddress();
    const groupId = `grp-no-${stamp}`;

    await receive({
      from: owner,
      content: "link me",
      handle: `no-dm-${stamp}`,
    });
    const identity = await waitForDatabase(async () => findIdentity(owner));
    const runsBefore = await prisma.run.count({ where: { botId: identity.botId } });

    await receive({
      from: owner,
      content: "group hello",
      groupId,
      participants: [owner, stranger, platformAddress],
      handle: `no-discover-${stamp}`,
    });
    const channel = await waitForDatabase(async () =>
      prisma.messagingChannel.findUnique({ where: { threadId: groupThreadId(groupId) } }),
    );

    await receive({
      from: owner,
      content: "NO",
      handle: `no-cmd-${stamp}`,
    });
    await waitForDatabase(async () => {
      const member = await prisma.messagingChannelMember.findUnique({
        where: { channelId_address: { channelId: channel.id, address: owner } },
      });
      return member?.status === "declined";
    });

    await receive({
      from: owner,
      content: "should not fan out",
      groupId,
      participants: [owner, stranger, platformAddress],
      handle: `no-ignored-${stamp}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await prisma.run.count({ where: { botId: identity.botId } })).toBe(runsBefore);
  });

  it("leaves an approved channel on LEAVE and can rejoin via a later invite", async () => {
    const owner = uniqueAddress();
    await seedLinkedAddress(owner);
    const stranger = uniqueAddress();
    const groupId = `grp-leave-${stamp}`;

    await receive({
      from: owner,
      content: "link me again",
      handle: `leave-dm-${stamp}`,
    });
    await waitForDatabase(async () => findIdentity(owner));

    await receive({
      from: owner,
      content: "group hello",
      groupId,
      participants: [owner, stranger, platformAddress],
      handle: `leave-discover-${stamp}`,
    });
    const channel = await waitForDatabase(async () =>
      prisma.messagingChannel.findUnique({ where: { threadId: groupThreadId(groupId) } }),
    );

    await receive({
      from: owner,
      content: "YES",
      handle: `leave-yes-${stamp}`,
    });
    await waitForDatabase(async () => {
      const member = await prisma.messagingChannelMember.findUnique({
        where: { channelId_address: { channelId: channel.id, address: owner } },
      });
      return member?.status === "approved";
    });

    await receive({
      from: owner,
      content: "LEAVE",
      handle: `leave-cmd-${stamp}`,
    });
    await waitForDatabase(async () => {
      const member = await prisma.messagingChannelMember.findUnique({
        where: { channelId_address: { channelId: channel.id, address: owner } },
      });
      return member?.status === "left";
    });

    await receive({
      from: owner,
      content: "back again",
      groupId,
      participants: [owner, stranger, platformAddress],
      handle: `leave-rejoin-${stamp}`,
    });
    await waitForDatabase(async () => {
      const member = await prisma.messagingChannelMember.findUnique({
        where: { channelId_address: { channelId: channel.id, address: owner } },
      });
      return member?.status === "invited";
    });
  });

  it("links a new address to an existing account via a web-issued code", async () => {
    const owner = await findIdentity(sender);
    expect(owner).toBeTruthy();
    // Unlink (as the web UI would) so the bot is free to link again.
    await prisma.messagingIdentity.delete({ where: { id: owner.id } });
    const issued = await issueMessagingLinkCode(prisma, {
      userId: owner.userId,
      spaceId: owner.spaceId,
      botId: owner.botId,
    });
    const newAddress = uniqueAddress();
    await receive({
      from: newAddress,
      content: formatMessagingLinkCode(issued.code),
    });
    const linked = await waitForDatabase(() => findIdentity(newAddress));
    expect(linked.userId).toBe(owner.userId);
    expect(linked.botId).toBe(owner.botId);
    // The confirmation is delivered to the newly linked address.
    await waitForDatabase(async () =>
      sentPosts().find((message) => message.to === newAddress && message.body.startsWith("Linked")),
    );
    // The code is single-use and an unknown sender cannot create an account.
    const replayAddress = uniqueAddress();
    await receive({
      from: replayAddress,
      content: formatMessagingLinkCode(issued.code),
    });
    await handles.awaitIdle?.();
    expect(await findIdentity(replayAddress)).toBeNull();
    expect(await prisma.user.count()).toBe(1);
  });
});

async function waitForDatabase<T>(pred: () => Promise<T | false | null | undefined>): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const value = await pred();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for database state");
}
