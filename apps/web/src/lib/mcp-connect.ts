import { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";
import type { RpcClient } from "./rpc";
import { rpc, rpcForSpace } from "./rpc";

export { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";

const MCP_OAUTH_TIMEOUT_MS = 2 * 60 * 1000;

export type McpOauthResult =
  | "connected"
  | "cancelled"
  | "already_connected"
  | "authorization_not_requested";

/** Run the browser OAuth popup flow for an MCP server: request an
 * authorization URL, open the popup, and wait until the callback page
 * broadcasts completion or the popup is closed without finishing.
 *
 * The BroadcastChannel (not window.opener) is the completion signal because
 * provider login pages with COOP sever the opener link. */
/** Where providers send the user back; a pre-registered client must allow it. */
export function mcpOAuthRedirectUri(): string {
  return `${window.location.origin}/mcp/oauth/callback`;
}

const MCP_OAUTH_SPACE_KEY = "rakazo:mcp-oauth-space";

/** The rpc client the callback page completes with: the space the flow began in. */
export function mcpOAuthCallbackRpc(): RpcClient {
  try {
    const spaceId = window.localStorage.getItem(MCP_OAUTH_SPACE_KEY);
    window.localStorage.removeItem(MCP_OAUTH_SPACE_KEY);
    if (spaceId) return rpcForSpace(spaceId);
  } catch {
    // Storage is unavailable: complete in the selected space.
  }
  return rpc;
}

/** `space` binds the flow to a space other than the selected one, callback included. */
export async function connectMcpOauth(
  serverId: string,
  space?: { client: RpcClient; spaceId: string | null },
): Promise<McpOauthResult> {
  const started = await (space?.client ?? rpc).mcp.oauth.begin({
    serverId,
    redirectUri: mcpOAuthRedirectUri(),
  });
  if (started.status !== "authorization_required") return started.status;
  try {
    if (space?.spaceId) window.localStorage.setItem(MCP_OAUTH_SPACE_KEY, space.spaceId);
    else window.localStorage.removeItem(MCP_OAUTH_SPACE_KEY);
  } catch {
    // Storage is unavailable: the callback completes in the selected space.
  }
  const popup = window.open(
    started.authorizationUrl,
    MCP_OAUTH_CHANNEL,
    "popup,width=560,height=720",
  );
  if (!popup) {
    // Popup blocked: navigate this tab instead; the callback page returns to /app.
    window.location.assign(started.authorizationUrl);
    return "cancelled";
  }
  return await new Promise<McpOauthResult>((resolve) => {
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    let settled = false;
    let pollTimer = 0;
    let timeoutTimer = 0;
    const finish = (result: McpOauthResult) => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      channel.close();
      resolve(result);
    };
    pollTimer = window.setInterval(() => {
      if (!popup.closed) return;
      finish("cancelled");
    }, 500);
    timeoutTimer = window.setTimeout(() => {
      popup.close();
      finish("cancelled");
    }, MCP_OAUTH_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type !== "mcp-oauth-complete") return;
      finish("connected");
    };
  });
}
