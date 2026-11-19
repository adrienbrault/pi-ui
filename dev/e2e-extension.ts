/**
 * The extension the end-to-end harness loads into pi: pi-prism at a chosen tail
 * budget, plus a stand-in for the `flan` provider the synthetic sessions name.
 *
 * The stand-in is what keeps the run offline. pi catches an exception thrown
 * from `before_provider_request` and sends the request anyway, and
 * `PI_OFFLINE` only disables startup network, so a submitted prompt would reach
 * whatever provider was loaded. Here the provider's only address is a closed
 * loopback port: a turn fails to connect and nothing leaves the machine.
 */

import prism from "../packages/pi-prism/extensions/index.ts";
import { setTailLines } from "../packages/pi-prism/render/detail.ts";

/** Port 9 (discard) is closed on a normal machine, so connecting fails at once. */
export const OFFLINE_BASE_URL = "http://127.0.0.1:9/v1";
export const E2E_MODEL = "deepseek-v4.1-flash-1017";

interface Pi {
  registerProvider(name: string, config: Record<string, unknown>): void;
}

export default function e2e(pi: Pi): void {
  if (process.env.PRISM_E2E_TAIL) setTailLines(Number(process.env.PRISM_E2E_TAIL));
  prism(pi as unknown as Parameters<typeof prism>[0]);
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
