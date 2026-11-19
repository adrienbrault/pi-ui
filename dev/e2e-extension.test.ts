import { expect, test } from "bun:test";
import e2e, { E2E_MODEL, OFFLINE_BASE_URL } from "./e2e-extension.ts";

test("the end-to-end provider can only reach a closed loopback port", () => {
  const providers: Array<[string, Record<string, unknown>]> = [];
  const pi = new Proxy(
    { registerProvider: (name: string, config: Record<string, unknown>) => providers.push([name, config]) },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => {}) },
  );
  e2e(pi);
  expect(providers).toHaveLength(1);
  const [name, config] = providers[0]!;
  expect(name).toBe("flan");
  expect(config.baseUrl).toBe(OFFLINE_BASE_URL);
  expect(new URL(OFFLINE_BASE_URL).hostname).toBe("127.0.0.1");
  expect((config.models as Array<{ id: string }>).map((model) => model.id)).toEqual([E2E_MODEL]);
});

test("the harness loads nothing from the user's pi directory", async () => {
  const harness = await Bun.file(`${import.meta.dir}/tui-e2e.ts`).text();
  expect(harness).not.toContain(".pi/agent");
  expect(harness).not.toContain("before_provider_request");
  expect(harness).toContain("--no-extensions");
});
