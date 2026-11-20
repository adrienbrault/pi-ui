/**
 * The extension the end-to-end harness loads into pi: pi-ui as it ships, plus
 * a stand-in for the `offline` provider the synthetic sessions name.
 *
 * The stand-in is what keeps the run offline. pi catches an exception thrown
 * from `before_provider_request` and sends the request anyway, and
 * `PI_OFFLINE` only disables startup network, so a submitted prompt would reach
 * whatever provider was loaded. Here the provider's only address is a closed
 * loopback port: a turn fails to connect and nothing leaves the machine.
 */

import piUi from "../packages/pi-ui/extensions/index.ts";

/** Port 9 (discard) is closed on a normal machine, so connecting fails at once. */
export const OFFLINE_BASE_URL = "http://127.0.0.1:9/v1";
export const E2E_MODEL = "offline-model-1";

/**
 * A second stand-in that answers from a script, in process, so a live turn can run a real tool
 * without any network: a prompt `run: <command>` gets one bash call with that command, and the
 * turn after a tool result gets `Script done.`.
 */
export const SCRIPT_PROVIDER = "pi-ui-script";
export const SCRIPT_MODEL = "pi-ui-script-1";

interface ScriptContext {
  messages: Array<{ role: string; content?: unknown }>;
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The scripted reply to `context`, as the events of one assistant response. */
export async function* scriptedReply(context: ScriptContext): AsyncGenerator<Record<string, unknown>> {
  const last = context.messages.at(-1);
  const text =
    typeof last?.content === "string"
      ? last.content
      : Array.isArray(last?.content)
        ? last.content.map((part: { text?: string }) => part.text ?? "").join("")
        : "";
  const command = last?.role === "user" && text.startsWith("run: ") ? text.slice("run: ".length) : undefined;
  const message = {
    role: "assistant",
    api: SCRIPT_PROVIDER,
    provider: SCRIPT_PROVIDER,
    model: SCRIPT_MODEL,
    usage: ZERO_USAGE,
    timestamp: Date.now(),
    stopReason: command ? "toolUse" : "stop",
    content: command
      ? [{ type: "toolCall", id: `script-${Date.now()}`, name: "bash", arguments: { command } }]
      : [{ type: "text", text: "Script done." }],
  };
  yield { type: "start", partial: { ...message, content: [] } };
  yield { type: "done", reason: message.stopReason, message };
}

interface Pi {
  registerProvider(name: string, config: Record<string, unknown>): void;
  on(event: "session_start", handler: (event: unknown, ctx: { ui?: ThemeUi }) => void): void;
}

interface ThemeUi {
  getTheme?(name: string): object | undefined;
  setTheme?(theme: object): unknown;
}

export default function e2e(pi: Pi): void {
  piUi(pi as unknown as Parameters<typeof piUi>[0]);
  // A fixed palette: the system theme stays grayscale under a headless tmux, where the
  // scroll bar's thumb and track share one colour. A Theme instance is not saved to settings.
  pi.on("session_start", (_event, ctx) => {
    const dark = ctx.ui?.getTheme?.("dark");
    if (dark) ctx.ui?.setTheme?.(dark);
  });
  pi.registerProvider("offline", {
    name: "offline",
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
  pi.registerProvider(SCRIPT_PROVIDER, {
    name: SCRIPT_PROVIDER,
    // Never contacted: the script answers in process.
    baseUrl: OFFLINE_BASE_URL,
    apiKey: "offline",
    api: SCRIPT_PROVIDER,
    streamSimple: (_model: unknown, context: ScriptContext) => scriptedReply(context),
    models: [
      {
        id: SCRIPT_MODEL,
        name: SCRIPT_MODEL,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
      },
    ],
  });
}
