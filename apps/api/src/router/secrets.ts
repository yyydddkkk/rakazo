import { ORPCError } from "@orpc/server";
import type { getBotSecretMetadata } from "@rakazo/adapters";
import {
  forgetBotSecret,
  listBotSecretMetadata,
  normalizeSecretDestination,
  storeBotSecret,
} from "@rakazo/adapters";
import type { Actor, BotSecretMetadata } from "@rakazo/contracts";
import { BotSecretAuth } from "@rakazo/contracts";
import { deleteAgentSecret, listAgentSecrets, putAgentSecret } from "../agent-secrets.js";
import type { RouterContext } from "./shared.js";
import { authed } from "./shared.js";

const BOT_SECRET_INPUT_ERRORS = [
  "Invalid credential destination",
  "Invalid credential length",
  "Credential cannot be used with this authentication method",
  "Remove the existing credential before changing its destination",
  "Credential limit reached",
];

/** Map credential validation failures to a bad request without echoing the submitted value. */
function mapBotSecretStoreError(error: unknown): unknown {
  if (error instanceof ORPCError) return error;
  if (
    error instanceof Error &&
    BOT_SECRET_INPUT_ERRORS.some((prefix) => error.message.startsWith(prefix))
  ) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }
  // Login decoding failures: a JSON parse message can quote the submitted value, so never forward it.
  if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
    return new ORPCError("BAD_REQUEST", {
      message: "A website login needs a username and password",
    });
  }
  return error;
}

function botSecretScope(actor: Actor, botId: string) {
  return { userId: actor.userId, spaceId: actor.spaceId, botId };
}

function botSecretMetadataDto(row: {
  name: string;
  origin: string;
  auth: unknown;
  createdAt: Date;
  updatedAt: Date;
}): BotSecretMetadata {
  // Unreadable or no-longer-storable destinations become auth:null so the owner UI stays remove-only.
  const parsed = BotSecretAuth.safeParse(row.auth);
  let auth: BotSecretMetadata["auth"] = null;
  if (parsed.success) {
    try {
      normalizeSecretDestination({ name: row.name, origin: row.origin, auth: parsed.data });
      auth = parsed.data;
    } catch {
      auth = null;
    }
  }
  return {
    name: row.name,
    origin: row.origin,
    auth,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function secretsRouter(ctx: RouterContext) {
  const { deps, repos } = ctx;
  return {
    agentSecrets: {
      list: authed.agentSecrets.list.handler(async ({ context }) =>
        listAgentSecrets({ prisma: deps.prisma, secrets: deps.secrets }, context.actor),
      ),
      put: authed.agentSecrets.put.handler(async ({ context, input, signal }) =>
        putAgentSecret(
          { prisma: deps.prisma, secrets: deps.secrets },
          context.actor,
          input,
          signal,
        ),
      ),
      remove: authed.agentSecrets.remove.handler(async ({ context, input }) =>
        deleteAgentSecret({ prisma: deps.prisma, secrets: deps.secrets }, context.actor, input.id),
      ),
    },
    botSecrets: {
      list: authed.botSecrets.list.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const rows = await listBotSecretMetadata(
          deps.prisma,
          botSecretScope(context.actor, bot.id),
        );
        return rows.map(botSecretMetadataDto);
      }),
      put: authed.botSecrets.put.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const scope = botSecretScope(context.actor, bot.id);
        let row: Awaited<ReturnType<typeof getBotSecretMetadata>>;
        try {
          row = await storeBotSecret({
            prisma: deps.prisma,
            secretStore: deps.secrets,
            scope,
            destination: input.destination,
            plaintext: input.value,
          });
        } catch (error) {
          throw mapBotSecretStoreError(error);
        }
        if (!row) throw new ORPCError("CONFLICT", { message: "Credential was not saved" });
        return botSecretMetadataDto(row);
      }),
      remove: authed.botSecrets.remove.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        await forgetBotSecret(deps.prisma, botSecretScope(context.actor, bot.id), input.name);
        return { ok: true as const };
      }),
    },
  };
}
