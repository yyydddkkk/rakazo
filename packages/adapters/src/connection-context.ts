import type { AdapterContext } from "@rakazo/adapter-kit";

export function selectRunConnections<
  T extends { connectorId: string; provider: string; status: string },
>(rows: T[]): T[] {
  return rows.filter((row) => row.status === "connected");
}

/** Authorized connection metadata shared by model runs and unattended checks. */
export function connectedContext(
  rows: Array<{
    id: string;
    connectorId: string;
    provider: string;
    displayName: string;
    providerRef: string | null;
  }>,
): Pick<AdapterContext, "connectedConnections" | "connectedProviders"> {
  return {
    connectedConnections: rows.map((row) => ({
      id: row.id,
      connectorId: row.connectorId,
      externalId: row.provider,
      displayName: row.displayName,
      providerRef: row.providerRef ?? undefined,
    })),
    connectedProviders: rows.map((row) => row.provider),
  };
}
