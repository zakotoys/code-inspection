export interface EnvironmentSupport {
  supported: boolean;
  reason: "remote" | "web" | null;
}
export interface DetectorRuntimeStatus {
  state: "ready" | "paused" | "unsupported";
  diagnosticsEnabled: boolean;
  unsupportedReason: EnvironmentSupport["reason"];
}
export function environmentSupport(
  remoteName: string | undefined,
  web: boolean,
): EnvironmentSupport {
  if (web) return { supported: false, reason: "web" };
  if (remoteName) return { supported: false, reason: "remote" };
  return { supported: true, reason: null };
}
