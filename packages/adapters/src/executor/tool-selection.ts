import {
  disabledBuiltinToolSet,
  FLEET_TOOL_NAMES,
  FLEET_WRITE_TOOL_NAMES,
} from "@rakazo/contracts";
import { isBackgroundRunTrigger, isOwnerStartedRun } from "@rakazo/core";
import { findDefaultModelCredential } from "@rakazo/db";
import { builtinAgentTools } from "../builtin-tools.js";
import { selectCloudAgentTools } from "../cloud-agent-tools-select.js";
import { resolveDeploymentModel } from "../deployment-model.js";
import type { FleetPrepareDeps } from "../fleet-tools.js";
import { selectConfiguredModel } from "../model-selection.js";
import { filterImageReturningComputerTools } from "../model-vision.js";
import { kickModelCredentialRefresh } from "../pi-oauth.js";
import { filterBuiltinToolsForRun, filterBuiltinToolsForThread } from "../schedule-tools.js";
import type { ExecutorDeps } from "./deps.js";

export const FLEET_TOOL_NAMES_SET: ReadonlySet<string> = new Set(FLEET_TOOL_NAMES);
export const FLEET_WRITE_TOOL_NAMES_SET: ReadonlySet<string> = new Set(FLEET_WRITE_TOOL_NAMES);

export function fleetPrepareDeps(
  deps: ExecutorDeps,
  scope: { userId: string; spaceId: string },
): FleetPrepareDeps {
  return {
    prisma: deps.prisma,
    modelChange: {
      secretStore: deps.secretStore,
      codexCatalog: deps.codexCatalog,
      refreshExpiredCredential: (credentialScope, secretId, provider) =>
        kickModelCredentialRefresh(
          deps.prisma,
          deps.secretStore,
          credentialScope,
          secretId,
          provider,
        ),
      defaultModel: async () => {
        const [defaultCredential, settings] = await Promise.all([
          findDefaultModelCredential(deps.prisma, scope),
          deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
        ]);
        const selected = selectConfiguredModel({
          override: null,
          overrideCredential: null,
          defaultCredential,
          settings,
          deployment: deps.deploymentModelConfigured ? resolveDeploymentModel() : null,
        });
        return { provider: selected.provider ?? null, model: selected.id ?? null };
      },
    },
  };
}

export function selectBuiltinToolsForRun(options: {
  ticketBoardEnabled?: boolean;
  historyRetrievalEnabled?: boolean;
  graphicalToolsAllowed: boolean;
  /** Page browser tools need a graphical computer (Chrome), not model vision. */
  pageBrowserAllowed?: boolean;
  groupId: string | null;
  trigger: string;
  cloudAgentEnabled?: boolean;
  mediaImagesEnabled?: boolean;
  mediaVideoEnabled?: boolean;
  messagingChannelRun: boolean;
  /** Built-in names this bot turned off. Unknown names are ignored. */
  disabledBuiltinTools?: readonly string[];
  /** The bot's fleet management switch. */
  fleetManagement?: boolean;
  /** A follow-up run whose source message the user wrote. */
  followUpFromUser?: boolean;
}) {
  const disabled = disabledBuiltinToolSet(options.disabledBuiltinTools);
  const fleetToolsAllowed = isOwnerStartedRun(options.trigger, Boolean(options.followUpFromUser));
  return selectCloudAgentTools(
    filterBuiltinToolsForRun(
      filterBuiltinToolsForThread(
        filterPageBrowserTools(
          filterImageReturningComputerTools(builtinAgentTools, options.graphicalToolsAllowed),
          options.pageBrowserAllowed ?? options.graphicalToolsAllowed,
        ),
        options.groupId,
      ),
      options.trigger,
    ),
    Boolean(options.cloudAgentEnabled),
  ).filter(
    (tool) =>
      !disabled.has(tool.name) &&
      (!FLEET_TOOL_NAMES_SET.has(tool.name) ||
        (Boolean(options.fleetManagement) && fleetToolsAllowed)) &&
      (options.mediaImagesEnabled || tool.name !== "generate_image") &&
      (options.mediaVideoEnabled || tool.name !== "generate_video") &&
      (options.ticketBoardEnabled ||
        (tool.name !== "board_tickets" && !tool.name.startsWith("ticket_"))) &&
      (!isBackgroundRunTrigger(options.trigger) ||
        ![
          "message_user",
          "message_bot",
          "handoff_to_bot",
          "message_agent",
          "generate_image",
          "generate_video",
        ].includes(tool.name)) &&
      (options.historyRetrievalEnabled ||
        !["search_history", "read_history"].includes(tool.name)) &&
      (!options.messagingChannelRun ||
        (!["remember", "save_shared_memory", "task_catalog", "board_tickets"].includes(tool.name) &&
          !tool.name.startsWith("scratchpad_") &&
          !tool.name.startsWith("ticket_"))),
  );
}

export const PAGE_BROWSER_TOOL_NAMES = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
]);

export function filterPageBrowserTools<T extends { name: string }>(
  tools: T[],
  pageBrowserAllowed: boolean,
): T[] {
  if (pageBrowserAllowed) return tools;
  return tools.filter((tool) => !PAGE_BROWSER_TOOL_NAMES.has(tool.name));
}
