/** Composio-style GitHub tools the emulator exposes for release watching. */
export const RELEASE_WATCH_GITHUB_TOOL_NAMES = [
  "GITHUB_LIST_RELEASES",
  "GITHUB_GET_RELEASE",
] as const;

export type EmulatedGithubRelease = {
  owner: string;
  repo: string;
  tag: string;
  name: string;
  body: string;
  publishedAt: string;
  htmlUrl: string;
};

/** Seeded rakazo releases so evals succeed without the public internet. */
export const DEFAULT_RAKAZO_EMULATED_RELEASES: readonly EmulatedGithubRelease[] = [
  {
    owner: "elie222",
    repo: "rakazo",
    tag: "v0.4.2",
    name: "v0.4.2 — routine tools + connector emulators",
    body: "Routines can bind connector tools. Composio emulator covers GitHub releases offline.",
    publishedAt: "2026-08-28T12:00:00.000Z",
    htmlUrl: "https://github.com/elie222/rakazo/releases/tag/v0.4.2",
  },
  {
    owner: "elie222",
    repo: "rakazo",
    tag: "v0.4.1",
    name: "v0.4.1 — computer + plugin guidance",
    body: "Prefer connected plugins over browsing when reading app data.",
    publishedAt: "2026-08-20T12:00:00.000Z",
    htmlUrl: "https://github.com/elie222/rakazo/releases/tag/v0.4.1",
  },
];
