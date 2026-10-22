import type { Bot, Routine } from "@rakazo/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { connectedAppMarks } from "../../lib/connected-apps";
import type { createSpaceRpc } from "../../lib/rpc";

export function useMentionSources(
  rpc: ReturnType<typeof createSpaceRpc>,
  bots: Bot[],
  initialBotsLoaded: boolean,
) {
  const [mentionRoutines, setMentionRoutines] = useState<Array<Routine & { botName?: string }>>([]);
  const [footerLogos, setFooterLogos] = useState<Array<{ name: string; logo: string | null }>>([]);
  const [mentionConnectors, setMentionConnectors] = useState<
    Array<{
      id: string;
      name: string;
      authStatus: "connected" | "needs_auth";
      connectionId?: string;
    }>
  >([]);
  const mentionBotsKey = useMemo(
    () => bots.map((bot) => `${bot.id}:${bot.name}`).join(","),
    [bots],
  );
  const botsForMentionsRef = useRef(bots);
  botsForMentionsRef.current = bots;

  useEffect(() => {
    const bots = botsForMentionsRef.current;
    if (!initialBotsLoaded || bots.length === 0) {
      setMentionRoutines([]);
      setMentionConnectors([]);
      if (!initialBotsLoaded) return;
    }
    let cancelled = false;
    const botNameById = new Map(bots.map((bot) => [bot.id, bot.name]));
    void Promise.all(
      bots.map((bot) =>
        rpc.routines
          .list({ botId: bot.id })
          .then((rows) =>
            rows.map((routine) => ({
              ...routine,
              botName: botNameById.get(bot.id) ?? bot.name,
            })),
          )
          .catch(() => [] as Array<Routine & { botName?: string }>),
      ),
    ).then((lists) => {
      if (!cancelled) setMentionRoutines(lists.flat());
    });
    // The catalog call reconciles connection rows, so list them after it.
    const catalogRequest = rpc.connections.catalog({}).catch(() => null);
    void Promise.all([
      catalogRequest.then(() => rpc.connections.list().catch(() => null)),
      catalogRequest,
    ]).then(([connections, catalog]) => {
      if (cancelled) return;
      const connected = connections?.filter((row) => row.status === "connected") ?? [];
      if (catalog && connections) setFooterLogos(connectedAppMarks(catalog, connections));
      const options: Array<{
        id: string;
        name: string;
        authStatus: "connected" | "needs_auth";
        connectionId?: string;
      }> = connected.map((row) => ({
        id: row.id,
        name: row.displayName,
        authStatus: "connected" as const,
        connectionId: row.id,
      }));
      for (const item of catalog ?? []) {
        if (item.connected || item.noAuth) continue;
        if (
          connected.some(
            (row) =>
              row.provider.toLowerCase() === item.slug.toLowerCase() ||
              row.displayName.toLowerCase() === item.name.toLowerCase(),
          )
        ) {
          continue;
        }
        options.push({
          id: `catalog:${item.connectorId}:${item.slug}`,
          name: item.name,
          authStatus: "needs_auth",
        });
      }
      setMentionConnectors(bots.length ? options : []);
    });
    return () => {
      cancelled = true;
    };
  }, [initialBotsLoaded, mentionBotsKey]);

  return { mentionRoutines, mentionConnectors, footerLogos, setFooterLogos };
}
