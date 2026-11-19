import { expect, test } from "bun:test";
import { CLIENT_JS } from "./html.ts";

/** Evaluate one top-level client function against stub globals. */
function clientFunction<T>(name: string, globals: Record<string, unknown>): T {
  const source = new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(CLIENT_JS)?.[0];
  if (!source) throw new Error(`client function ${name} not found`);
  const names = Object.keys(globals);
  return new Function(...names, `${source}\nreturn ${name};`)(...names.map((key) => globals[key])) as T;
}

test("a new tail budget replaces the click targets along with the frames", () => {
  const entry = {
    id: "ours.group",
    data: { collapsed: { k: "old frames" } },
    reveal: { collapsed: { k: "old groups" } },
    blocks: { collapsed: { k: "old blocks" } },
  };
  const other = { id: "ours.read", data: { l0: { k: "kept" } } };
  const groupOpenState: Record<string, number> = { "ours.group:0:1": 1, "ours.read:0:1": 1 };
  const revealOpenState: Record<string, number> = { "ours.group:0:1:0": 1 };
  const blockOpenState: Record<string, number> = { "ours.group:0:b1": 1 };
  let painted = 0;
  const applyTail = clientFunction<(res: unknown) => void>("applyTail", {
    byId: (id: string) => [entry, other].find((candidate) => candidate.id === id),
    DS: { meta: {} },
    paintAll: () => painted++,
    groupOpenState,
    revealOpenState,
    blockOpenState,
  });
  applyTail({
    meta: { bodyLines: {} },
    entries: [
      {
        id: "ours.group",
        data: { collapsed: { k: "new frames" } },
        reveal: { collapsed: { k: "new groups" } },
        blocks: { collapsed: { k: "new blocks" } },
      },
    ],
  });
  expect(entry.data.collapsed.k).toBe("new frames");
  expect(entry.reveal.collapsed.k).toBe("new groups");
  expect(entry.blocks.collapsed.k).toBe("new blocks");
  expect(other.data.l0.k).toBe("kept");
  // Indices into the old layout no longer name the same rows: close what they opened.
  expect(groupOpenState).toEqual({ "ours.read:0:1": 1 });
  expect(revealOpenState).toEqual({});
  expect(blockOpenState).toEqual({});
  expect(painted).toBe(1);
});
