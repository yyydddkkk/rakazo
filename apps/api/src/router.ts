import { accountRouter } from "./router/account.js";
import { approvalsRouter } from "./router/approvals.js";
import { artifactsRouter } from "./router/artifacts.js";
import { boardRouter } from "./router/board.js";
import { botsRouter } from "./router/bots.js";
import { computerRouter } from "./router/computer.js";
import { connectionsRouter } from "./router/connections.js";
import { mcpRouter } from "./router/mcp.js";
import { memoryRouter } from "./router/memory.js";
import { messagingRouter } from "./router/messaging.js";
import { modelsRouter } from "./router/models.js";
import { routinesRouter } from "./router/routines.js";
import { secretsRouter } from "./router/secrets.js";
import type { RouterDeps } from "./router/shared.js";
import { createRouterContext, os } from "./router/shared.js";
import { skillsRouter } from "./router/skills.js";
import { threadsRouter } from "./router/threads.js";
import { usageRouter } from "./router/usage.js";

export { enqueueBotIntroRun } from "./router/bots.js";
export type { RouterDeps } from "./router/shared.js";
export { HEARTBEAT_MS, SESSION_RECHECK_MS } from "./router/shared.js";

export function createRouter(deps: RouterDeps) {
  const ctx = createRouterContext(deps);
  return os.router({
    ...accountRouter(ctx),
    ...modelsRouter(ctx),
    ...botsRouter(ctx),
    ...threadsRouter(ctx),
    ...computerRouter(ctx),
    ...memoryRouter(ctx),
    ...routinesRouter(ctx),
    ...boardRouter(ctx),
    ...skillsRouter(ctx),
    ...mcpRouter(ctx),
    ...connectionsRouter(ctx),
    ...messagingRouter(ctx),
    ...secretsRouter(ctx),
    ...approvalsRouter(ctx),
    ...artifactsRouter(ctx),
    ...usageRouter(ctx),
  });
}
