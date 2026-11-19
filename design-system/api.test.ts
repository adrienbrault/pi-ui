import { expect, test } from "bun:test";
import { serial } from "./api.ts";

test("a failed render does not block the renders queued after it", async () => {
  const run = serial();
  const order: string[] = [];
  const failed = run(async () => {
    order.push("first");
    throw new Error("render failed");
  });
  const next = run(async () => {
    order.push("second");
    return "ok";
  });
  await expect(failed).rejects.toThrow("render failed");
  expect(await next).toBe("ok");
  expect(await run(async () => "later")).toBe("later");
  expect(order).toEqual(["first", "second"]);
});

test("renders never interleave", async () => {
  const run = serial();
  let active = 0;
  let overlap = false;
  const task = async () => {
    active++;
    if (active > 1) overlap = true;
    await Bun.sleep(1);
    active--;
  };
  await Promise.all([run(task), run(task), run(task)]);
  expect(overlap).toBe(false);
});
