import { beforeAll, expect, test } from "bun:test";
import { getMarkdownTheme, initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { RenderTheme } from "../render/kit.ts";
import { restyleUserMessage, USER_MESSAGE_BG } from "./user-message.ts";

beforeAll(() => initTheme("dark"));

const painted: string[] = [];
const theme = (tag: string): RenderTheme => ({
  fg: (_token, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  style: (text, options) => {
    painted.push(`${tag}:${options.bg}`);
    return `[${tag}]${text}`;
  },
});

const prompt = () => new UserMessageComponent("Review the fold planner.", getMarkdownTheme(), 1);

test("a user message keeps its own rows only, on the neutral background", () => {
  const plain = prompt().render(40);
  expect(plain).toHaveLength(3);

  painted.length = 0;
  const component = prompt();
  restyleUserMessage(component, theme("a"));
  const rows = component.render(40);
  expect(rows).toHaveLength(1);
  expect(stripTerminalSequences(rows[0]!)).toContain("[a] Review the fold planner.");
  expect(new Set(painted)).toEqual(new Set([`a:${USER_MESSAGE_BG}`]));
});

test("restyling again only picks up a new theme", () => {
  const component = prompt();
  restyleUserMessage(component, theme("a"));
  restyleUserMessage(component, theme("a"));
  expect(component.render(40)).toHaveLength(1);
  painted.length = 0;
  restyleUserMessage(component, theme("b"));
  expect(component.render(40)[0]).toContain("[b]");
  expect(painted.every((entry) => entry.startsWith("b:"))).toBe(true);
});

test("a one-row prompt still starts with its OSC 133 prompt mark, so pi can jump to it", () => {
  const component = prompt();
  restyleUserMessage(component, theme("a"));
  const [row] = component.render(40);
  expect(row!.startsWith("\x1b]133;A\x07")).toBe(true);
  expect(row).toContain("\x1b]133;B\x07\x1b]133;C\x07");
});
