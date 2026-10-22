/** Local contracts for the deterministic legacy connector fake. No vendor SDK is loaded. */
export type ConnectedAccountStatus =
  | "ACTIVE"
  | "EXPIRED"
  | "INACTIVE"
  | "FAILED"
  | "REVOKED"
  | "INITIATED"
  | "INITIALIZING";
export type ToolkitDirectoryEntry = {
  slug: string;
  name: string;
  logo: string | null;
  noAuth: boolean;
};
export type ConnectedAccountListParams = {
  toolkitSlugs?: string[];
  userIds?: string[];
  statuses?: ConnectedAccountStatus[];
  limit?: number;
  cursor?: string;
};
export type ConnectedAccountRetrieveResponse = {
  id: string;
  authConfig: { id: string; isComposioManaged: boolean; isDisabled: boolean };
  status: ConnectedAccountStatus;
  statusReason: string | null;
  toolkit: { slug: string };
  isDisabled: boolean;
  createdAt: string;
  updatedAt: string;
};
export type ConnectedAccountListResponse = {
  items: ConnectedAccountRetrieveResponse[];
  totalPages: number;
  nextCursor: string | null;
};
export type ToolRouterCreateSessionConfig = {
  manageConnections?: boolean;
  sandbox?: { enable: boolean };
  toolkits?: string[];
  connectedAccounts?: Record<string, string[]>;
  multiAccount?: {
    enable?: boolean;
    maxAccountsPerToolkit?: number;
    requireExplicitSelection?: boolean;
  };
};
export type ToolRouterToolkitsOptions = {
  search?: string;
  toolkits?: string[];
  isConnected?: boolean;
  limit?: number;
  cursor?: string;
};
export type ConnectionRequest = {
  id: string;
  status: "ACTIVE";
  redirectUrl: null;
  waitForConnection(timeout?: number): Promise<ConnectedAccountRetrieveResponse>;
  toJSON(): unknown;
  toString(): string;
};
export type ComposioSession = {
  sessionId: string;
  toolkits(options?: ToolRouterToolkitsOptions): Promise<{
    items: Array<{
      slug: string;
      name: string;
      isNoAuth: boolean;
      logo?: string;
      connection?: {
        isActive: boolean;
        connectedAccount: { id: string; status: ConnectedAccountStatus };
      };
    }>;
    cursor?: string;
    totalPages: number;
  }>;
  tools(): Promise<
    Array<{
      type: "function";
      function: { name: string; description: string; parameters: Record<string, unknown> };
    }>
  >;
  execute(
    tool: string,
    args?: Record<string, unknown>,
    options?: { account?: string },
  ): Promise<{ data: unknown; error: string | null; logId: string }>;
  authorize(toolkit: string, options?: { callbackUrl?: string }): Promise<ConnectionRequest>;
};
export type ComposioClient = {
  create(userId: string, config: ToolRouterCreateSessionConfig): Promise<ComposioSession>;
  sessions: { use(sessionId: string): Promise<ComposioSession> };
  connectedAccounts: {
    list(
      query?: ConnectedAccountListParams,
      options?: { signal?: AbortSignal },
    ): Promise<ConnectedAccountListResponse>;
    waitForConnection(id: string, timeout?: number): Promise<ConnectedAccountRetrieveResponse>;
    delete(id: string, options?: { signal?: AbortSignal }): Promise<{ success: boolean }>;
  };
};
