import type { RouterContext } from "./shared.js";
import { authed } from "./shared.js";

export function workflowsRouter({ workflows }: RouterContext) {
  return {
    workflows: {
      list: authed.workflows.list.handler(({ context }) => workflows.list(context.actor)),
      install: authed.workflows.install.handler(({ context, input }) =>
        workflows.install(context.actor, input),
      ),
      updateVersion: authed.workflows.updateVersion.handler(({ context, input }) =>
        workflows.updateVersion(context.actor, input),
      ),
      setEnabled: authed.workflows.setEnabled.handler(({ context, input }) =>
        workflows.setEnabled(context.actor, input),
      ),
      remove: authed.workflows.remove.handler(({ context, input }) =>
        workflows.remove(context.actor, input.packageId),
      ),
      getBot: authed.workflows.getBot.handler(({ context, input }) =>
        workflows.getBot(context.actor, input.botId),
      ),
      setBot: authed.workflows.setBot.handler(({ context, input }) =>
        workflows.setBot(context.actor, input),
      ),
    },
  };
}
