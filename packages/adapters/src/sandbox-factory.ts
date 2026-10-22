import type { SandboxProvider } from "@rakazo/adapter-kit";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { NoneSandboxProvider } from "./none-sandbox.js";

export interface SandboxProviderOptions {
  supervisorUrl?: string;
  supervisorToken?: string;
}

export function createSandboxProvider(kind: string, opts: SandboxProviderOptions): SandboxProvider {
  switch (kind) {
    case "none":
    case "":
      return new NoneSandboxProvider();
    case "docker":
      return new DockerSandboxProvider(
        opts.supervisorUrl ?? "http://127.0.0.1:7091",
        opts.supervisorToken,
      );
    case "fake":
      return new FakeSandboxProvider();
    default:
      throw new Error(`Unknown SANDBOX_PROVIDER "${kind}". Use none | docker | fake.`);
  }
}
