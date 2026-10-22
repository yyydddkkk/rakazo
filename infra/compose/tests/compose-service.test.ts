import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ComposeService {
  image?: string;
  profiles?: string[];
  ports?: unknown[];
  networks?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  env_file?: unknown;
  command?: unknown;
  user?: string;
}

const composeFile = path.resolve(import.meta.dirname, "../docker-compose.prod.yml");
const compose = parse(readFileSync(composeFile, "utf8"), { merge: true }) as {
  services: Record<string, ComposeService>;
  networks: Record<string, unknown>;
};

describe("the production computer provider", () => {
  it.each(["api", "worker"])(
    "lets .env select the %s provider with an unconfigured default",
    (name) => {
      expect(compose.services[name]?.environment?.SANDBOX_PROVIDER).toBe(
        "${SANDBOX_PROVIDER:-none}",
      );
    },
  );
});

describe("production host isolation", () => {
  it("does not expose the Docker socket to the API", () => {
    expect(
      (compose.services.api?.volumes ?? []).some((volume) => volume.includes("docker.sock")),
    ).toBe(false);
  });
  it("digest-pins third-party runtime images", () => {
    expect(compose.services.postgres?.image).toMatch(/@sha256:[a-f0-9]{64}/);
  });
});
