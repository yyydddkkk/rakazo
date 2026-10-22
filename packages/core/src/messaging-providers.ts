const PROVIDER_NAMES: Record<string, string> = {
  lark: "Feishu",
};

/** User-facing name of a messaging provider (falls back to the raw id). */
export function messagingProviderName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}
