import { expect, test } from "bun:test";
import e2e, { E2E_MODEL, OFFLINE_BASE_URL, SCRIPT_MODEL, SCRIPT_PROVIDER, scriptedReply } from "./e2e-extension.ts";

test("the end-to-end providers can only reach a closed loopback port, or answer in process", () => {
  const providers: Array<[string, Record<string, unknown>]> = [];
  const pi = new Proxy(
    { registerProvider: (name: string, config: Record<string, unknown>) => providers.push([name, config]) },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => {}) },
  );
  e2e(pi);
  expect(providers.map(([name]) => name)).toEqual(["flan", SCRIPT_PROVIDER]);
  for (const [, config] of providers) expect(config.baseUrl).toBe(OFFLINE_BASE_URL);
  expect(new URL(OFFLINE_BASE_URL).hostname).toBe("127.0.0.1");
  const [flan, script] = providers.map(([, config]) => config);
  expect((flan!.models as Array<{ id: string }>).map((model) => model.id)).toEqual([E2E_MODEL]);
  expect((script!.models as Array<{ id: string }>).map((model) => model.id)).toEqual([SCRIPT_MODEL]);
  expect(typeof script!.streamSimple).toBe("function");
});

test("the script answers `run: <command>` with one bash call, and a tool result with text", async () => {
  const events = async (messages: Array<{ role: string; content: unknown }>) =>
    Array.fromAsync(scriptedReply({ messages }));
  const call = (await events([{ role: "user", content: [{ type: "text", text: "run: echo hi" }] }])).at(-1);
  expect(call).toMatchObject({
    type: "done",
    reason: "toolUse",
    message: { content: [{ type: "toolCall", name: "bash", arguments: { command: "echo hi" } }] },
  });
  const done = (await events([{ role: "toolResult", content: [] }])).at(-1);
  expect(done).toMatchObject({ type: "done", reason: "stop", message: { content: [{ text: "Script done." }] } });
});

test("the harness loads nothing from the user's pi directory", async () => {
  const harness = await Bun.file(`${import.meta.dir}/tui-e2e.ts`).text();
  expect(harness).not.toContain(".pi/agent");
  expect(harness).not.toContain("before_provider_request");
  expect(harness).toContain("--no-extensions");
});
