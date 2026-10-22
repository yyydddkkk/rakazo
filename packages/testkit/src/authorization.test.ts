import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeComposioClient, FakeConnectorProvider } from "@rakazo/adapters";
import type { appContract, SpaceNavigation } from "@rakazo/contracts";
import { runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { fixtureAccountResponse, resetAdminFixture } from "./fixture-account.js";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;
type RpcPath<T, Prefix extends string = ""> = T extends { "~orpc": unknown }
  ? Prefix
  : T extends object
    ? {
        [Key in keyof T & string]: RpcPath<T[Key], Prefix extends "" ? Key : `${Prefix}/${Key}`>;
      }[keyof T & string]
    : never;
type ProtectedRpcPath = Exclude<RpcPath<typeof appContract>, "health">;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;
let botIntroHarness: BotIntroHarness | undefined;

describeWithDatabase("API authorization and resource isolation", () => {
  let handles: AppHandles;
  let db: AppHandles["prisma"];
  let app: App;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-authz-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      connectors: [new FakeConnectorProvider({ client: new FakeComposioClient() })],
    });
    app = handles.app;
    db = asSystem(handles.prisma);
    botIntroHarness = handles;
  });

  beforeEach(async () => {
    await resetAdminFixture(
      process.env.RAKAZO_ADMIN_EMAIL!,
      process.env.RAKAZO_ADMIN_PASSWORD!,
      "Authorization admin",
    );
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects unauthenticated calls to every protected RPC family", async () => {
    const calls = exhaustiveProtectedCalls([
      ["me"],
      ["deployment/get"],
      ["models/list"],
      ["models/credentials"],
      ["models/connect", { provider: "test", apiKey: "not-a-real-key" }],
      ["models/beginOAuth", { provider: "openai-codex" }],
      ["models/submitOAuthCode", { loginId: "missing-login", code: "fake-code" }],
      ["models/completeOAuth", { loginId: "missing-login" }],
      ["models/finishOAuth", { loginId: "missing-login" }],
      ["models/cancelOAuth", { loginId: "missing-login" }],
      ["models/setDefault", { provider: "test", modelId: "test/model" }],
      ["spaces/list"],
      ["bots/list"],
      ["bots/listArchived"],
      ["bots/get", { botId: "missing-bot" }],
      ["bots/create", botInput("Unauthenticated")],
      ["bots/duplicate", { botId: "missing-bot" }],
      ["bots/update", { botId: "missing-bot", name: "Nope" }],
      ["bots/archive", { botId: "missing-bot" }],
      ["bots/restore", { botId: "missing-bot" }],
      ["bots/remove", { botId: "missing-bot" }],
      ["groups/create", { name: "Nope", botIds: ["missing-a", "missing-b"] }],
      ["groups/list"],
      ["groups/get", { groupId: "missing-group" }],
      ["groups/update", { groupId: "missing-group", name: "Nope" }],
      ["groups/remove", { groupId: "missing-group" }],
      ["botSections/list"],
      ["botSections/create", { botId: "missing-bot", name: "Planning" }],
      ["botSections/update", { sectionId: "missing-section", name: "Planning" }],
      ["botSections/remove", { sectionId: "missing-section" }],
      ["threads/get", { botId: "missing-bot" }],
      ["threads/get", { groupId: "missing-group" }],
      ["threads/messages", { botId: "missing-bot", before: 1 }],
      ["threads/subscribe", { botId: "missing-bot", cursor: -1 }],
      ["threads/send", { botId: "missing-bot", text: "Nope" }],
      ["threads/send", { groupId: "missing-group", text: "Nope" }],
      ["threads/stop", { botId: "missing-bot" }],
      ["threads/clear", { botId: "missing-bot" }],
      ["threads/followUp", { botId: "missing-bot", text: "Nope" }],
      [
        "threads/answer",
        {
          botId: "missing-bot",
          runId: "missing-run",
          messageId: "missing-message",
          answer: "Nope",
        },
      ],
      ["threads/markRead", { botId: "missing-bot" }],
      ["threads/markUnread", { botId: "missing-bot" }],
      ["computer/status", { botId: "missing-bot" }],
      ["computer/boot", { botId: "missing-bot" }],
      ["computer/stop", { botId: "missing-bot" }],
      ["computer/takeover", { botId: "missing-bot" }],
      ["computer/release", { botId: "missing-bot" }],
      ["computer/input", { botId: "missing-bot", kind: "key", payload: { key: "A" } }],
      ["computer/files", { botId: "missing-bot", path: "/" }],
      ["computer/readFile", { botId: "missing-bot", path: "MEMORY.md" }],
      ["computer/screenUrl", { botId: "missing-bot" }],
      ["computer/heartbeat", { botId: "missing-bot" }],
      ["memory/list", {}],
      ["memory/update", { documentId: "missing-memory", content: "Nope" }],
      ["memory/exportMarkdown", {}],
      ["routines/list", { botId: "missing-bot" }],
      ["routines/create", routineInput("missing-bot")],
      ["routines/update", { routineId: "missing-routine", name: "Nope" }],
      ["routines/remove", { routineId: "missing-routine" }],
      ["routines/testRun", { routineId: "missing-routine" }],
      ["scratchpad/list", { botId: "missing-bot" }],
      ["scratchpad/create", { botId: "missing-bot", title: "Nope" }],
      ["scratchpad/update", { itemId: "missing-item", title: "Nope" }],
      ["scratchpad/remove", { itemId: "missing-item" }],
      ["skills/list", { botId: "missing-bot" }],
      ["skills/get", { skillId: "missing-skill" }],
      ["skills/start", { botId: "missing-bot", goal: "Demonstrate export" }],
      [
        "skills/appendEvent",
        {
          skillId: "missing-skill",
          event: { at: new Date().toISOString(), kind: "key", key: "a" },
        },
      ],
      ["skills/snapshot", { skillId: "missing-skill" }],
      ["skills/stop", { skillId: "missing-skill" }],
      ["skills/updateDraft", { skillId: "missing-skill", playbook: skillPlaybookInput() }],
      ["skills/save", { skillId: "missing-skill" }],
      ["skills/testRun", { skillId: "missing-skill" }],
      ["skills/remove", { skillId: "missing-skill" }],
      ["agentSkills/list"],
      ["agentSkills/get", { skillId: "missing-skill" }],
      ["agentSkills/create", { name: "Unauthenticated", description: "Nope", body: "Steps" }],
      ["agentSkills/update", { skillId: "missing-skill", description: "Nope" }],
      ["agentSkills/remove", { skillId: "missing-skill" }],
      ["capabilities/list"],
      ["capabilities/install", capabilityInput("Unauthenticated")],
      ["capabilities/remove", { id: "missing-capability" }],
      ["connections/catalog", {}],
      ["connections/list"],
      ["connections/begin", connectionInput("Unauthenticated")],
      ["connections/complete", { connectionId: "missing-connection" }],
      ["connections/revoke", { connectionId: "missing-connection" }],
      ["approvalRules/list"],
      [
        "approvalRules/set",
        { effect: "require_approval", matchKind: "category", matchValue: "email" },
      ],
      ["approvalRules/remove", { id: "missing-rule" }],
      ["artifacts/list", { botId: "missing-bot" }],
      ["usage/list"],
      ["usage/summary"],
      ["export/bot", { botId: "missing-bot" }],
      ["search/query", { q: "anything" }],
    ]);

    const results = await Promise.all(
      calls.map(async ([procedure, input]) => ({
        procedure,
        response: await raw(app, "", procedure, input),
      })),
    );

    for (const { procedure, response } of results) {
      expect(response.status, procedure).toBe(401);
    }
  });

  it("prevents one user from reading or mutating another user's resources", async () => {
    const owner = await signup(app, `owner-authz-${stamp}@rakazo.test`, "Authorization Owner");
    const intruder = await signup(
      app,
      `intruder-authz-${stamp}@rakazo.test`,
      "Authorization Intruder",
    );
    const ownerActor = await rpc<Actor>(app, owner, "me");
    const intruderActor = await rpc<Actor>(app, intruder, "me");
    expect(ownerActor.spaceId).not.toBe(intruderActor.spaceId);

    const ownerBot = await rpc<Bot>(app, owner, "bots/create", botInput("Owner Bot"));
    const intruderBot = await rpc<Bot>(app, intruder, "bots/create", botInput("Intruder Bot"));
    const ownerRoutine = await rpc<{ id: string }>(
      app,
      owner,
      "routines/create",
      routineInput(ownerBot.id),
    );
    const ownerScratchpad = await rpc<{ id: string }>(app, owner, "scratchpad/create", {
      botId: ownerBot.id,
      title: "Owner open work",
      notes: "private",
    });
    const ownerSkill = await db.taughtSkill.create({
      data: {
        spaceId: ownerActor.spaceId,
        botId: ownerBot.id,
        userId: ownerActor.userId,
        name: "Owner Skill",
        goal: "Owner-only skill",
        status: "saved",
        playbook: skillPlaybookInput(),
        recording: { events: [], snapshots: [] },
      },
    });
    const ownerAgentSkill = await rpc<{ id: string }>(app, owner, "agentSkills/create", {
      name: "Owner Recipe",
      description: "Owner-only shared skill",
      body: "1. Do the private thing.",
    });
    const ownerCapability = await rpc<{ id: string }>(
      app,
      owner,
      "capabilities/install",
      capabilityInput("Owner Capability"),
    );
    const ownerConnection = await rpc<{ connectionId: string }>(
      app,
      owner,
      "connections/begin",
      connectionInput("Owner Connection"),
    );
    const ownerMemory = await db.memoryDocument.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        scope: "bot",
        path: "PRIVATE.md",
        content: "owner-only-memory",
      },
    });
    const ownerArtifact = await db.artifact.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        name: "owner-secret.txt",
        mimeType: "text/plain",
        size: 17,
        hash: "sha256:not-a-real-hash",
        storageKey: "test/owner-secret.txt",
      },
    });
    const ownerThread = await db.thread.findUniqueOrThrow({
      where: { botId: ownerBot.id },
    });
    const ownerTask = await asSystem(handles.prisma).task.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        threadId: ownerThread.id,
        prompt: "owner prompt",
        status: "waiting_input",
      },
    });
    const ownerRun = await asSystem(handles.prisma).run.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        threadId: ownerThread.id,
        taskId: ownerTask.id,
        status: "waiting_input",
        trigger: "user",
      },
    });

    const botIdCalls: Array<[string, unknown]> = [
      ["bots/get", { botId: ownerBot.id }],
      ["bots/duplicate", { botId: ownerBot.id }],
      ["bots/update", { botId: ownerBot.id, name: "Stolen Bot" }],
      ["bots/archive", { botId: ownerBot.id }],
      ["bots/restore", { botId: ownerBot.id }],
      ["threads/get", { botId: ownerBot.id }],
      ["threads/messages", { botId: ownerBot.id, before: 1 }],
      ["threads/subscribe", { botId: ownerBot.id, cursor: -1 }],
      ["threads/send", { botId: ownerBot.id, text: "intruder message" }],
      ["threads/send", { botId: ownerBot.id, artifactIds: [ownerArtifact.id] }],
      ["threads/stop", { botId: ownerBot.id }],
      ["threads/clear", { botId: ownerBot.id }],
      ["threads/followUp", { botId: ownerBot.id, text: "intruder follow-up" }],
      [
        "threads/answer",
        {
          botId: ownerBot.id,
          runId: ownerRun.id,
          messageId: "missing-message",
          answer: "intruder answer",
        },
      ],
      ["threads/markRead", { botId: ownerBot.id }],
      ["threads/markUnread", { botId: ownerBot.id }],
      ["computer/status", { botId: ownerBot.id }],
      ["computer/boot", { botId: ownerBot.id }],
      ["computer/stop", { botId: ownerBot.id }],
      ["computer/takeover", { botId: ownerBot.id }],
      ["computer/release", { botId: ownerBot.id }],
      ["computer/input", { botId: ownerBot.id, kind: "key", payload: { key: "A" } }],
      ["computer/files", { botId: ownerBot.id, path: "/" }],
      ["computer/readFile", { botId: ownerBot.id, path: "PRIVATE.md" }],
      ["computer/screenUrl", { botId: ownerBot.id }],
      ["computer/heartbeat", { botId: ownerBot.id }],
      ["routines/list", { botId: ownerBot.id }],
      ["routines/create", routineInput(ownerBot.id)],
      ["scratchpad/list", { botId: ownerBot.id }],
      ["scratchpad/create", { botId: ownerBot.id, title: "Stolen item" }],
      ["skills/list", { botId: ownerBot.id }],
      ["skills/start", { botId: ownerBot.id, goal: "Intruder demo" }],
      ["artifacts/list", { botId: ownerBot.id }],
      [
        "artifacts/create",
        {
          botId: ownerBot.id,
          name: "intruder.txt",
          mimeType: "text/plain",
          contentBase64: Buffer.from("nope").toString("base64"),
        },
      ],
      ["artifacts/get", { botId: ownerBot.id, artifactId: ownerArtifact.id }],
      ["export/bot", { botId: ownerBot.id }],
    ];
    await Promise.all(
      botIdCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    const ownerBot2 = await rpc<Bot>(app, owner, "bots/create", botInput("Owner Bot Two"));
    const ownerGroup = await rpc<{ id: string }>(app, owner, "groups/create", {
      name: "Owner Group",
      botIds: [ownerBot.id, ownerBot2.id],
    });
    const groupCalls: Array<[string, unknown]> = [
      ["groups/get", { groupId: ownerGroup.id }],
      ["groups/update", { groupId: ownerGroup.id, name: "Stolen Group" }],
      ["groups/remove", { groupId: ownerGroup.id }],
      ["threads/get", { groupId: ownerGroup.id }],
      ["threads/messages", { groupId: ownerGroup.id, before: 1 }],
      ["threads/subscribe", { groupId: ownerGroup.id, cursor: -1 }],
      ["threads/send", { groupId: ownerGroup.id, text: "intruder group message" }],
      ["threads/stop", { groupId: ownerGroup.id }],
      ["threads/followUp", { groupId: ownerGroup.id, text: "intruder follow-up" }],
      ["threads/markRead", { groupId: ownerGroup.id }],
      ["threads/markUnread", { groupId: ownerGroup.id }],
    ];
    await Promise.all(
      groupCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    // A caller cannot pair their own bot with another workspace's run ID.
    await expectDenied(app, intruder, "threads/answer", {
      botId: intruderBot.id,
      runId: ownerRun.id,
      messageId: "missing-message",
      answer: "mixed-resource attack",
    });

    const resourceIdCalls = [
      ["routines/update", { routineId: ownerRoutine.id, name: "Stolen Routine" }],
      ["routines/remove", { routineId: ownerRoutine.id }],
      ["routines/testRun", { routineId: ownerRoutine.id }],
      ["scratchpad/update", { itemId: ownerScratchpad.id, title: "Stolen item" }],
      ["scratchpad/remove", { itemId: ownerScratchpad.id }],
      ["skills/get", { skillId: ownerSkill.id }],
      [
        "skills/appendEvent",
        { skillId: ownerSkill.id, event: { at: new Date().toISOString(), kind: "key", key: "x" } },
      ],
      ["skills/snapshot", { skillId: ownerSkill.id }],
      ["skills/stop", { skillId: ownerSkill.id }],
      ["skills/updateDraft", { skillId: ownerSkill.id, playbook: skillPlaybookInput() }],
      ["skills/save", { skillId: ownerSkill.id }],
      ["skills/testRun", { skillId: ownerSkill.id }],
      ["skills/remove", { skillId: ownerSkill.id }],
      ["agentSkills/get", { skillId: ownerAgentSkill.id }],
      ["agentSkills/update", { skillId: ownerAgentSkill.id, description: "Stolen" }],
      ["agentSkills/remove", { skillId: ownerAgentSkill.id }],
      ["memory/update", { documentId: ownerMemory.id, content: "stolen" }],
      ["connections/complete", { connectionId: ownerConnection.connectionId }],
    ] satisfies Array<[string, unknown]>;
    await Promise.all(
      resourceIdCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    expect(await rpc<unknown[]>(app, intruder, "memory/list", { botId: ownerBot.id })).toEqual([]);
    expect(await rpc<string>(app, intruder, "memory/exportMarkdown", { botId: ownerBot.id })).toBe(
      "",
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "capabilities/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerCapability.id }),
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "agentSkills/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerAgentSkill.id }),
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "connections/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerConnection.connectionId }),
    );
    expect(
      await rpc<{ hits: unknown[] }>(app, intruder, "search/query", { q: ownerBot.name }),
    ).toEqual({ hits: [] });

    // These endpoints are deliberately idempotent for unknown IDs. Success must not mutate
    // a row in a different workspace or disclose whether it exists.
    await rpc(app, intruder, "capabilities/remove", { id: ownerCapability.id });
    await rpc(app, intruder, "connections/revoke", {
      connectionId: ownerConnection.connectionId,
    });
    expect(
      await handles.prisma.capabilityInstall.findUnique({ where: { id: ownerCapability.id } }),
    ).not.toBeNull();
    expect(
      await asSystem(handles.prisma).connection.findUniqueOrThrow({
        where: { id: ownerConnection.connectionId },
      }),
    ).toMatchObject({ status: "connected", userId: ownerActor.userId });

    const ownerBotAfter = await asSystem(handles.prisma).bot.findUniqueOrThrow({
      where: { id: ownerBot.id },
    });
    expect(ownerBotAfter.name).toBe("Owner Bot");
    expect(
      await asSystem(handles.prisma).routine.findUniqueOrThrow({ where: { id: ownerRoutine.id } }),
    ).toMatchObject({ name: "Owner Routine" });
    expect(
      await asSystem(handles.prisma).scratchpadItem.findUniqueOrThrow({
        where: { id: ownerScratchpad.id },
      }),
    ).toMatchObject({ title: "Owner open work", notes: "private" });
    expect(
      await db.memoryDocument.findUniqueOrThrow({ where: { id: ownerMemory.id } }),
    ).toMatchObject({ content: "owner-only-memory" });

    // Destructive bot removal is checked last so an authorization regression is unmistakable.
    await expectDenied(app, intruder, "bots/remove", {
      botId: ownerBot.id,
      deleteMemories: true,
    });
    expect(
      await asSystem(handles.prisma).bot.findUnique({ where: { id: ownerBot.id } }),
    ).not.toBeNull();
  });

  it("ends the session when signing out with an empty body", async () => {
    const phone = await phoneSession(app, `phone-sign-out-${stamp}@rakazo.test`);
    const signedOut = await app.request("/api/auth/sign-out", {
      method: "POST",
      body: "",
      headers: { ...phone.headers, "content-type": "application/json", "content-length": "0" },
    });
    expect(signedOut.status).toBe(200);
    expect(await phone.me()).toBe(401);
  });

  it("still rejects a malformed auth body", async () => {
    const phone = await phoneSession(app, `phone-malformed-${stamp}@rakazo.test`);
    const response = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: { ...phone.headers, "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await phone.me()).toBe(200);
  });

  it("marks account and RPC replies as not cacheable, including errors", async () => {
    const email = `phone-no-store-${stamp}@rakazo.test`;
    const phone = await phoneSession(app, email);
    const rpc = (path: string, headers: Record<string, string>) =>
      app.request(`/rpc/${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      });
    const signIn = (password: string) =>
      app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({ email, password }),
      });
    const responses = {
      signIn: await signIn("password12"),
      wrongPassword: await signIn("wrong-pass"),
      blockedAuthPath: await app.request("/api/auth/organization/list"),
      oversizedAuthBody: await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(1024 * 1024) },
        body: "{}",
      }),
      me: await rpc("me", phone.headers),
      signedOutMe: await rpc("me", { origin: "http://127.0.0.1:5173" }),
      unknownProcedure: await rpc("not-a-procedure", phone.headers),
    };

    expect(
      Object.fromEntries(
        Object.entries(responses).map(([name, response]) => [
          name,
          [response.status, response.headers.get("cache-control")],
        ]),
      ),
    ).toEqual({
      signIn: [200, "no-store"],
      wrongPassword: [401, "no-store"],
      blockedAuthPath: [404, "no-store"],
      oversizedAuthBody: [413, "no-store"],
      me: [200, "no-store"],
      signedOutMe: [401, "no-store"],
      unknownProcedure: [404, "no-store"],
    });
  });

  it("uses the bearer session over another account's session cookie", async () => {
    const a = await phoneSession(app, `phone-cookie-a-${stamp}@rakazo.test`);
    const b = await phoneSession(app, `phone-cookie-b-${stamp}@rakazo.test`);
    const both = { ...b.headers, cookie: a.cookie, "content-type": "application/json" };
    const me = () =>
      app.request("/rpc/me", { method: "POST", headers: both, body: JSON.stringify({ json: {} }) });

    const signedIn = await me();
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toMatchObject({ json: { userId: b.userId } });

    const signedOut = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: both,
      body: "{}",
    });
    expect(signedOut.status).toBe(200);
    expect((await me()).status).toBe(401);
    expect(await a.me()).toBe(200);
  });

  it("accepts only signed bearer tokens, and every sign-in hands one out", async () => {
    const email = `phone-signed-${stamp}@rakazo.test`;
    const phone = await phoneSession(app, email);
    const me = async (token: string) =>
      (
        await app.request("/rpc/me", {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1:5173",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ json: {} }),
        })
      ).status;
    const authJson = async (path: string, token: string, body: unknown) => {
      const response = await app.request(`/api/auth${path}`, {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:5173",
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      const json = (await response.json()) as { token: string };
      expect(json.token).toBe(decodeURIComponent(response.headers.get("set-auth-token") ?? ""));
      return json.token;
    };

    const stored = await handles.prisma.session.findFirstOrThrow({
      where: { userId: phone.userId },
      select: { token: true },
    });
    expect(phone.token.startsWith(`${stored.token}.`)).toBe(true);
    expect(await me(phone.token)).toBe(200);
    expect(await me(encodeURIComponent(phone.token))).toBe(200);

    // A token copied out of the session table, or given a forged signature, is not a session.
    expect(await me(stored.token)).toBe(401);
    expect(await me(`${stored.token}.${"A".repeat(43)}=`)).toBe(401);
    const rawSession = await app.request("/api/auth/get-session", {
      headers: { origin: "http://127.0.0.1:5173", authorization: `Bearer ${stored.token}` },
    });
    expect(await rawSession.json()).toBeNull();

    const signedIn = await authJson("/sign-in/email", "", { email, password: "password12" });
    expect(await me(signedIn)).toBe(200);

    // Replacing the session on a password change hands the phone the signed replacement.
    const replaced = await authJson("/change-password", signedIn, {
      currentPassword: "password12",
      newPassword: "password34",
      revokeOtherSessions: true,
    });
    expect(replaced).not.toBe(signedIn);
    expect(await me(replaced)).toBe(200);
    expect(await me(signedIn)).toBe(401);
  });

  it("keeps approval rules private to each account", async () => {
    const owner = await signup(app, `approval-owner-${stamp}@rakazo.test`, "Approval Owner");
    const member = await signup(app, `approval-member-${stamp}@rakazo.test`, "Approval Member");
    const ownerActor = await rpc<Actor>(app, owner, "me");
    const memberActor = await rpc<Actor>(app, member, "me");

    expect(ownerActor.spaceId).not.toBe(memberActor.spaceId);
    const ownerRule = await rpc<{ id: string }>(app, owner, "approvalRules/set", {
      effect: "always_allow",
      matchKind: "tool",
      matchValue: "destination.write",
    });
    expect(await rpc<unknown[]>(app, member, "approvalRules/list")).toEqual([]);

    const memberRule = await rpc<{ id: string }>(app, member, "approvalRules/set", {
      effect: "require_approval",
      matchKind: "category",
      matchValue: "email",
    });
    expect(await rpc<Array<{ id: string }>>(app, owner, "approvalRules/list")).toEqual([
      expect.objectContaining({ id: ownerRule.id }),
    ]);
    expect(await rpc<Array<{ id: string }>>(app, member, "approvalRules/list")).toEqual([
      expect.objectContaining({ id: memberRule.id }),
    ]);

    await rpc(app, member, "approvalRules/remove", { id: ownerRule.id });
    expect(
      await asSystem(handles.prisma).actionApprovalRule.findUnique({ where: { id: ownerRule.id } }),
    ).not.toBeNull();
  });

  it("keeps space data and computers behind the account's space boundary", async () => {
    const owner = await signup(app, `spaces-${stamp}@rakazo.test`, "Space Owner");
    const other = await signup(app, `spaces-other-${stamp}@rakazo.test`, "Other owner");
    const actor = await rpc<Actor>(app, owner, "me");
    const otherActor = await rpc<Actor>(app, other, "me");
    const originalBot = await rpc<Bot>(app, owner, "bots/create", botInput("Open source"));
    const otherBot = await rpc<Bot>(app, other, "bots/create", botInput("Other bot"));
    expect(actor.spaceId).not.toBe(otherActor.spaceId);
    expect(await rpc<Array<{ id: string }>>(app, owner, "bots/list")).toEqual([
      expect.objectContaining({ id: originalBot.id }),
    ]);
    expect(await rpc<Array<{ id: string }>>(app, other, "bots/list")).toEqual([
      expect.objectContaining({ id: otherBot.id }),
    ]);
    await expectDenied(app, owner, "bots/get", { botId: otherBot.id });
    await expectDenied(app, other, "bots/get", { botId: originalBot.id });
    for (const procedure of ["me", "spaces/list", "bots/list"]) {
      await expectDenied(app, owner, procedure, {}, otherActor.spaceId);
      await expectDenied(app, other, procedure, {}, actor.spaceId);
    }
    const navigation = await rpc<SpaceNavigation>(app, owner, "spaces/list");
    expect(navigation.current).toEqual(
      expect.objectContaining({
        id: actor.spaceId,
        bots: [expect.objectContaining({ id: originalBot.id })],
      }),
    );
    expect(navigation.spaces).toEqual([
      expect.objectContaining({
        id: actor.spaceId,
        bots: [expect.objectContaining({ id: originalBot.id, notifyOnFinish: false })],
        canRename: false,
        canDelete: false,
      }),
    ]);
    const storedBots = await db.bot.findMany({
      where: { id: { in: [originalBot.id, otherBot.id] } },
      select: { id: true, spaceId: true, computerId: true },
    });
    const storedOriginal = storedBots.find((bot) => bot.id === originalBot.id);
    const storedOther = storedBots.find((bot) => bot.id === otherBot.id);
    expect(storedOriginal?.spaceId).toBe(actor.spaceId);
    expect(storedOther?.spaceId).toBe(otherActor.spaceId);
    expect(storedOriginal?.computerId).not.toBe(storedOther?.computerId);
  });

  it("rotates model credentials and keeps defaults private to the account", async () => {
    const cookie = await signup(app, `model-defaults-${stamp}@rakazo.test`, "Model Defaults");
    const actor = await rpc<Actor>(app, cookie, "me");
    const other = await signup(app, `model-other-${stamp}@rakazo.test`, "Other models");
    const expectSpaceModelDefault = async (spaceId: string, provider: string, modelId: string) => {
      const preference = await db.spaceModelPreference.findFirst({
        where: { userId: actor.userId, spaceId, isDefault: true },
        include: { credential: true },
      });
      expect(preference).toMatchObject({ modelId, credential: { provider } });
    };

    const connectedA = await rpc<ModelCredential>(app, cookie, "models/connect", {
      provider: "provider-a",
      apiKey: "fake-provider-a-key",
      label: "Provider A",
      modelId: "a/one",
    });
    expect(connectedA.isDefault).toBe(true);
    const providerABeforeRotation = await db.userModelCredential.findUniqueOrThrow({
      where: { id: connectedA.id },
    });

    const rotatedA = await rpc<ModelCredential>(app, cookie, "models/connect", {
      provider: "provider-a",
      apiKey: "fake-provider-a-replacement-key",
      label: "Provider A rotated",
      modelId: "a/rotated",
    });
    const providerAAfterRotation = await db.userModelCredential.findUniqueOrThrow({
      where: { id: connectedA.id },
    });
    expect(rotatedA.id).toBe(connectedA.id);
    expect(providerAAfterRotation.secretId).not.toBe(providerABeforeRotation.secretId);
    expect(
      await db.secret.findUnique({ where: { id: providerABeforeRotation.secretId } }),
    ).toBeNull();
    await expect(
      db.secret.findUniqueOrThrow({ where: { id: providerAAfterRotation.secretId } }),
    ).resolves.toMatchObject({ userId: actor.userId, spaceId: null, kind: "model" });
    expect(
      await db.userModelCredential.count({
        where: { userId: actor.userId, provider: "provider-a" },
      }),
    ).toBe(1);

    expect(await rpc<ModelCredential[]>(app, other, "models/credentials")).toEqual([]);
    await expectSpaceModelDefault(actor.spaceId, "provider-a", "a/rotated");

    const connectedB = await rpc<ModelCredential>(app, cookie, "models/connect", {
      provider: "provider-b",
      apiKey: "fake-provider-b-key",
      label: "Provider B",
      modelId: "b/one",
    });
    expect(connectedB.isDefault).toBe(true);
    await expectSpaceModelDefault(actor.spaceId, "provider-b", "b/one");

    await rpc(app, cookie, "models/setDefault", { provider: "provider-a", modelId: "a/two" });
    await expectSpaceModelDefault(actor.spaceId, "provider-a", "a/two");

    await rpc(app, cookie, "models/setDefault", { provider: "provider-b", modelId: "b/two" });
    await expectSpaceModelDefault(actor.spaceId, "provider-b", "b/two");

    await rpc(app, cookie, "models/setDefault", { provider: "provider-a", modelId: "a/three" });
    await expectSpaceModelDefault(actor.spaceId, "provider-a", "a/three");
    const listed = await rpc<ModelCredential[]>(app, cookie, "models/credentials");
    expect(JSON.stringify(listed)).not.toContain("fake-provider-a-key");
    expect(JSON.stringify(listed)).not.toContain("fake-provider-b-key");

    const missing = await raw(app, cookie, "models/setDefault", {
      provider: "missing-provider",
      modelId: "missing/model",
    });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(await missing.text()).toMatch(/credential/i);
  });

  it("keeps the Better Auth organization routes closed to product sessions", async () => {
    const cookie = await signup(app, `org-routes-${stamp}@rakazo.test`, "Org Routes");
    const actor = await rpc<Actor>(app, cookie, "me");

    for (const route of ["delete", "leave", "update", "list"]) {
      const res = await app.request(`/api/auth/organization/${route}`, {
        method: route === "list" ? "GET" : "POST",
        headers: {
          ...(route === "list" ? {} : { "content-type": "application/json" }),
          cookie,
          origin: "http://127.0.0.1:5173",
        },
        body:
          route === "list"
            ? undefined
            : JSON.stringify({ organizationId: actor.spaceId, data: { name: "Renamed" } }),
      });
      expect(res.status, route).toBe(404);
    }

    await expect(
      handles.prisma.space.findMany({
        where: { id: actor.spaceId },
        select: { id: true },
      }),
    ).resolves.toHaveLength(1);
    await expect(
      handles.prisma.member.count({ where: { userId: actor.userId } }),
    ).resolves.toBeGreaterThan(0);
    expect((await raw(app, cookie, "me")).status).toBe(200);
  });

  it("validates custom thinking against the saved connection capability", async () => {
    const cookie = await signup(app, `custom-thinking-${stamp}@rakazo.test`, "Custom Thinking");
    const bot = await rpc<Bot>(app, cookie, "bots/create", botInput("Thinking Bot"));
    const connection = {
      provider: "openai-compatible",
      modelId: "arbitrary-model",
      baseUrl: "http://localhost:8000/v1",
    };
    await rpc(app, cookie, "models/connect", {
      ...connection,
      apiKey: "fake-saved-key",
      reasoning: false,
    });
    await rpc(app, cookie, "models/connect", { ...connection, reasoning: true });
    const actor = await rpc<Actor>(app, cookie, "me");
    expect(
      await runAsSystem("background job run.continue", () =>
        handles.executor.resolveModel({
          userId: actor.userId,
          spaceId: actor.spaceId,
          botId: bot.id,
        }),
      ),
    ).toMatchObject({ apiKey: "fake-saved-key", reasoning: true });
    const update = {
      botId: bot.id,
      modelProvider: connection.provider,
      modelId: connection.modelId,
    };
    expect(
      await rpc(app, cookie, "bots/update", { ...update, thinkingLevel: "low" }),
    ).toMatchObject({ thinkingLevel: "low" });
    expect(
      await rpc(app, cookie, "bots/update", { ...update, thinkingLevel: "xhigh" }),
    ).toMatchObject({ thinkingLevel: "xhigh" });
    expect(
      await rpc(app, cookie, "bots/update", { ...update, thinkingLevel: "max" }),
    ).toMatchObject({ thinkingLevel: "max" });
    await rpc(app, cookie, "models/connect", { ...connection, reasoning: false });
    expect(
      (await raw(app, cookie, "bots/update", { ...update, thinkingLevel: "low" })).status,
    ).toBe(400);
    expect(
      (await raw(app, cookie, "bots/update", { ...update, thinkingLevel: "xhigh" })).status,
    ).toBe(400);
    expect(
      await rpc(app, cookie, "bots/update", { ...update, thinkingLevel: "off" }),
    ).toMatchObject({ thinkingLevel: "off" });
  });

  it("validates per-bot model overrides against connected providers and catalog", async () => {
    const cookie = await signup(app, `bot-model-${stamp}@rakazo.test`, "Bot Model");
    const bot = await rpc<
      Bot & {
        modelProvider: string | null;
        modelId: string | null;
        thinkingLevel: string | null;
      }
    >(app, cookie, "bots/create", botInput("Model Bot"));
    await rpc(app, cookie, "models/connect", {
      provider: "xai",
      apiKey: "fake-xai-key-not-real",
      label: "xAI",
      modelId: "grok-4.6",
    });

    const updated = await rpc<
      Bot & {
        modelProvider: string | null;
        modelId: string | null;
        thinkingLevel: string | null;
      }
    >(app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: "xai",
      modelId: "grok-4.6",
      thinkingLevel: "high",
    });
    expect(updated).toMatchObject({
      modelProvider: "xai",
      modelId: "grok-4.6",
      thinkingLevel: "high",
    });

    const unknown = await raw(app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: "xai",
      modelId: "not-a-real-grok",
    });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(await unknown.text()).toMatch(/unknown model/i);

    const disconnected = await raw(app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-6",
    });
    expect(disconnected.status).toBeGreaterThanOrEqual(400);
    expect(await disconnected.text()).toMatch(/connect/i);

    const partialClear = await raw(app, cookie, "bots/update", {
      botId: bot.id,
      modelId: null,
    });
    expect(partialClear.status).toBeGreaterThanOrEqual(400);
    expect(await partialClear.text()).toMatch(/both be set or both cleared/i);
  });

  it("binds a new default to the space preference credential, not a newer unused duplicate", async () => {
    const cookie = await signup(app, `model-duplicates-${stamp}@rakazo.test`, "Model Duplicates");
    const actor = await rpc<Actor>(app, cookie, "me");
    const olderSecret = await db.secret.create({
      data: {
        userId: actor.userId,
        spaceId: null,
        kind: "model",
        ciphertext: "encrypted-older-key",
      },
    });
    const newerSecret = await db.secret.create({
      data: {
        userId: actor.userId,
        spaceId: null,
        kind: "model",
        ciphertext: "encrypted-newer-key",
      },
    });
    const older = await db.userModelCredential.create({
      data: {
        userId: actor.userId,
        provider: "duplicate-provider",
        label: "Older",
        secretId: olderSecret.id,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    });
    const newer = await db.userModelCredential.create({
      data: {
        userId: actor.userId,
        provider: "duplicate-provider",
        label: "Newer",
        secretId: newerSecret.id,
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date("2026-02-02T00:00:00.000Z"),
      },
    });
    await db.spaceModelPreference.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        credentialId: older.id,
        modelId: "older/model",
        isDefault: true,
      },
    });

    await rpc(app, cookie, "models/setDefault", {
      provider: "duplicate-provider",
      modelId: "newer/selected",
    });

    const preferences = await db.spaceModelPreference.findMany({
      where: { userId: actor.userId, spaceId: actor.spaceId },
    });
    expect(preferences.filter((row) => row.isDefault).map((row) => row.credentialId)).toEqual([
      older.id,
    ]);
    expect(preferences.find((row) => row.credentialId === older.id)).toMatchObject({
      isDefault: true,
      modelId: "newer/selected",
    });
    expect(preferences.find((row) => row.credentialId === newer.id)).toBeUndefined();
    const listed = await rpc<ModelCredential[]>(app, cookie, "models/credentials");
    expect(
      listed.filter((row) => row.provider === "duplicate-provider").map((row) => row.id),
    ).toEqual([newer.id, older.id]);
  });

  it("never hands out session tokens and asks for the password before account deletion", async () => {
    const email = `sessions-${stamp}@rakazo.test`;
    const cookie = await signup(app, email, "Sessions");
    const second = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12" }),
    });
    const { token } = (await second.json()) as { token: string };
    expect(token).toEqual(expect.any(String));

    const listed = await app.request("/api/auth/list-sessions", { headers: { cookie } });
    expect(listed.status).toBe(200);
    const text = await listed.text();
    const sessions = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(2);
    for (const session of sessions) expect(session).not.toHaveProperty("token");
    expect(text).not.toContain(token);
    const current = (await (
      await app.request("/api/auth/get-session", { headers: { cookie } })
    ).json()) as { session: Record<string, unknown> };
    expect(current.session).not.toHaveProperty("token");

    const deleted = await app.request("/api/auth/delete-user", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({}),
    });
    expect(deleted.status).toBe(400);
    expect(await handles.prisma.user.findUnique({ where: { email } })).not.toBeNull();
  });

  it("restricts deployment access to the deployment owner", async () => {
    const owner = await signup(app, `deployment-owner-${stamp}@rakazo.test`, "Deployment Owner");
    const other = await signup(app, `deployment-other-${stamp}@rakazo.test`, "Deployment Other");
    const ownerActor = await rpc<Actor>(app, owner, "me");
    const otherActor = await rpc<Actor>(app, other, "me");
    await db.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: ownerActor.userId },
    });
    expect(otherActor.userId).not.toBe(ownerActor.userId);
    await rpc(app, owner, "deployment/get");
    await expectDenied(app, other, "deployment/get", {});
  });
});

function botInput(name: string) {
  return {
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  };
}

function routineInput(botId: string) {
  return {
    botId,
    name: "Owner Routine",
    prompt: "owner-only prompt",
    crons: ["0 9 * * 1"],
    timezone: "UTC",
    notify: false,
    active: false,
  };
}

function skillPlaybookInput() {
  return {
    whenToUse: "When needed",
    inputs: ["example"],
    steps: ["Do the thing"],
    howToCheck: "Verify result",
    whatToReturn: "Summary",
    approvalBoundaries: "Ask first",
    failureHandling: "Stop and ask",
  };
}

function capabilityInput(name: string) {
  return { kind: "skill", name, source: "test://authorization", config: {} };
}

function connectionInput(displayName: string) {
  return { connectorId: "composio", provider: "SLACK", displayName };
}

async function signup(_app: App, email: string, name: string) {
  const response = await fixtureAccountResponse(
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name }),
    },
    botIntroHarness?.prisma,
  );
  if (response.status >= 400) {
    throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  }
  return sessionCookieHeader(response);
}

async function phoneSession(app: App, email: string) {
  const response = await fixtureAccountResponse(
    { body: JSON.stringify({ email, password: "password12", name: "Phone" }) },
    botIntroHarness?.prisma,
  );
  const { user } = (await response.json()) as { user: { id: string } };
  const cookie = sessionCookieHeader(response);
  const encodedToken = cookie
    .split(";")
    .find((part) => part.trim().startsWith("better-auth.session_token="))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!encodedToken) throw new Error("Missing signed fixture session");
  const token = decodeURIComponent(encodedToken);
  const headers = { origin: "http://127.0.0.1:5173", authorization: `Bearer ${token}` };
  const me = async () =>
    (
      await app.request("/rpc/me", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      })
    ).status;
  return { headers, me, cookie, userId: user.id, token };
}

async function raw(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
) {
  return app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body ?? {} }),
  });
}

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
): Promise<T> {
  const response = await raw(app, cookie, procedure, body, spaceId);
  const text = await response.text();
  const payload = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || payload.error) {
    throw new Error(`${procedure} ${response.status}: ${payload.error?.message ?? text}`);
  }
  return discardBotIntroFromCreate(botIntroHarness, cookie, procedure, payload.json as T);
}

async function expectDenied(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown,
  spaceId?: string,
) {
  const response = await raw(app, cookie, procedure, body, spaceId);
  if (procedure === "threads/subscribe" && response.status === 200) {
    // Streaming transports commit the HTTP 200 before advancing the async iterator. The
    // ownership error is therefore encoded in the iterator response instead of the status.
    expect(await response.text(), procedure).toMatch(/error|forbidden|not.found|unauthorized/i);
    return;
  }
  expect(response.status, procedure).toBeGreaterThanOrEqual(400);
}
interface Actor {
  userId: string;
  spaceId: string;
}

interface ModelCredential {
  id: string;
  provider: string;
  label: string;
  hasKey: boolean;
  isDefault: boolean;
}

interface Bot {
  id: string;
}

function exhaustiveProtectedCalls<
  const Calls extends ReadonlyArray<readonly [ProtectedRpcPath, unknown?]>,
>(calls: Calls & (ProtectedRpcPath extends Calls[number][0] ? unknown : never)): Calls {
  return calls;
}
