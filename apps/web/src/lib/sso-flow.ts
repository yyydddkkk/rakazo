type SsoResult = {
  data: { url?: string } | null;
  error: { message?: string; code?: string } | null;
};

export function runSsoFlow(
  begin: (disableRedirect: boolean, callbackURL: (url: string) => string) => Promise<SsoResult>,
  _callbackURLs: readonly string[],
): Promise<SsoResult> {
  return begin(false, (url) => url);
}
