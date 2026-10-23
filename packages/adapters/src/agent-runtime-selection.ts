import path from "node:path";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import { OmpRpcRuntime } from "./omp-runtime.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";

/** Shared composition for the API and worker; bot overrides share the same instances. */
export function createAgentRuntimeSelection(options: {
  defaultRuntime?: string;
  dataDir: string;
  piSessionRoot?: string;
}): {
  runtime: AgentRuntime;
  runtimeFor: (name: string | null | undefined) => AgentRuntime;
} {
  const instances = new Map<string, AgentRuntime>();
  const defaultName = options.defaultRuntime ?? "pi";
  const runtimeFor = (name: string | null | undefined): AgentRuntime => {
    const selected = name ?? defaultName;
    const existing = instances.get(selected);
    if (existing) return existing;
    const runtime =
      selected === "pi"
        ? new PiAgentRuntime({ sessionRoot: options.piSessionRoot })
        : selected === "omp"
          ? new OmpRpcRuntime({ workspaceRoot: path.resolve(options.dataDir, "omp-workspaces") })
          : selected === "scripted"
            ? new ScriptedAgentRuntime()
            : undefined;
    if (!runtime) throw new Error("Unsupported agent runtime");
    instances.set(selected, runtime);
    return runtime;
  };
  return { runtime: runtimeFor(defaultName), runtimeFor };
}
