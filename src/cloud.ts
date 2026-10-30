import type { FactoryCtx } from "./runtime.js";

export type CloudSession = { url?: string; end(): Promise<void> };

/**
 * Optional live view in Mozaik Cloud. Uses its own variable (GROUT_MOZAIK_KEY) on purpose: the runtime's
 * built-in exporter reads MOZAIK_API_KEY and opens a separate session for every agent loop, while this
 * exporter ships the whole run, custom events included, as one session.
 */
export async function attachCloud(fc: FactoryCtx, env: Record<string, string | undefined>, fetcher?: typeof fetch): Promise<CloudSession | undefined> {
  const projectKey = env.GROUT_MOZAIK_KEY;
  if (!projectKey) return undefined;
  const { createCloudExporter } = await import("@mozaik-ai/cloud-sdk/exporter");
  const session: CloudSession = { end: async () => {} };
  const exporter = createCloudExporter({
    endpoint: env.GROUT_MOZAIK_ENDPOINT ?? "https://api.app.jigjoy.ai/v1/events",
    projectKey,
    participants: () => fc.rt.resolveRuntime().state.getParticipants(),
    redaction: "none",
    ...(fetcher ? { fetch: fetcher } : {}),
    onSessionUrl: (url) => (session.url = url),
    onError: () => undefined,
  });
  fc.rt.join(exporter.participant);
  session.end = () => exporter.end();
  return session;
}
