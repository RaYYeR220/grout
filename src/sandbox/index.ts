import { DockerSandbox, dockerAvailable } from "./docker.js";
import { LocalSandbox } from "./local.js";
import type { Sandbox } from "./types.js";

export type SandboxPreference = "docker" | "local" | "auto";

export async function createSandbox(pref: SandboxPreference): Promise<Sandbox> {
  if (pref === "local") return new LocalSandbox();
  if (pref === "docker") return new DockerSandbox();
  return (await dockerAvailable()) ? new DockerSandbox() : new LocalSandbox();
}

export type { Sandbox, CmdResult, ExecOptions } from "./types.js";
