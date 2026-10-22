export function initialBootstrapTarget(pathname: string) {
  const appRoute = pathname === "/app" || pathname.startsWith("/app/");
  if (!appRoute) return null;
  return { botId: botIdFromPath(pathname) };
}

function botIdFromPath(pathname: string) {
  const segments = pathname.split("/");
  if (segments[2] === "g" || segments[2] === "artifacts" || segments[2] === "board")
    return undefined;
  const encoded = segments[2];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}
