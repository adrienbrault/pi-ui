/**
 * The extension the end-to-end harness loads into pi: pi-prism as it ships, plus
 * a stand-in for the `flan` provider the synthetic sessions name.
 *
 * The stand-in is what keeps the run offline. pi catches an exception thrown
 * from `before_provider_request` and sends the request anyway, and
 * `PI_OFFLINE` only disables startup network, so a submitted prompt would reach
 * whatever provider was loaded. Here the provider's only address is a closed
 * loopback port: a turn fails to connect and nothing leaves the machine.
 */

import prism from "../packages/pi-prism/extensions/index.ts";

/** Port 9 (discard) is closed on a normal machine, so connecting fails at once. */
export const OFFLINE_BASE_URL = "http://127.0.0.1:9/v1";
export const E2E_MODEL = "deepseek-v4.1-flash-1017";

interface Pi {
  registerProvider(name: string, config: Record<string, unknown>): void;
  on(event: "session_start", handler: (event: unknown, ctx: { ui?: ThemeUi }) => void): void;
}

interface ThemeUi {
  getTheme?(name: string): object | undefined;
  setTheme?(theme: object): unknown;
}

export default function e2e(pi: Pi): void {
  prism(pi as unknown as Parameters<typeof prism>[0]);
  // A fixed palette: the system theme stays grayscale under a headless tmux, where the
  // scroll bar's thumb and track share one colour. A Theme instance is not saved to settings.
  pi.on("session_start", (_event, ctx) => {
    const dark = ctx.ui?.getTheme?.("dark");
    if (dark) ctx.ui?.setTheme?.(dark);
  });
  pi.registerProvider("flan", {
    name: "flan",
    baseUrl: OFFLINE_BASE_URL,
    apiKey: "offline",
    api: "openai-completions",
    models: [
      {
        id: E2E_MODEL,
        name: E2E_MODEL,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
      },
    ],
  });
}
