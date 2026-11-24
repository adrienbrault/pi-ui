/**
 * pi draws a submitted prompt as a Markdown child on `userMessageBg`, padded one
 * row above and below. pi-ui keeps the prompt's own rows only, on the neutral
 * `toolPendingBg`, so the prompt reads as a quiet band rather than a coloured box.
 */

import { PROMPT_BG, type RenderTheme } from "../render/kit.ts";

export const USER_MESSAGE_BG = PROMPT_BG;

interface MarkdownLike {
  paddingY: number;
  defaultTextStyle: { bgColor?: (text: string) => string } & Record<string, unknown>;
  invalidate?: () => void;
}

/** The theme each restyled Markdown paints with; a theme change only has to update this. */
const themes = new WeakMap<object, RenderTheme>();
const patched = new WeakSet<object>();

const PROMPT_START = "\x1b]133;A\x07";

/**
 * pi marks a prompt's first row with OSC 133;A and its last with 133;B and 133;C.
 * Without padding rows, a one-row prompt gets both on one row with 133;A last, and
 * pi's jump to the previous prompt only finds rows that start with 133;A.
 */
function keepPromptStart(component: unknown): void {
  const target = component as { render?: (width: number) => string[] };
  if (patched.has(target) || typeof target.render !== "function") return;
  patched.add(target);
  const render = target.render.bind(target);
  target.render = (width) => {
    const lines = render(width);
    const first = lines[0];
    if (first?.includes(PROMPT_START) && !first.startsWith(PROMPT_START)) {
      lines[0] = PROMPT_START + first.replace(PROMPT_START, "");
    }
    return lines;
  };
}

function markdownOf(component: unknown): MarkdownLike | undefined {
  const child = (component as { children?: unknown[] }).children?.[0] as Partial<MarkdownLike> | undefined;
  if (typeof child?.paddingY !== "number") return undefined;
  if (typeof child.defaultTextStyle !== "object" || child.defaultTextStyle === null) return undefined;
  return child as MarkdownLike;
}

/** Restyle a user message component in place; repeat calls only pick up a new theme. */
export function restyleUserMessage(component: unknown, theme: RenderTheme): void {
  const markdown = markdownOf(component);
  if (!markdown) return;
  const previous = themes.get(markdown);
  if (previous === theme) return;
  themes.set(markdown, theme);
  if (!previous) {
    keepPromptStart(component);
    markdown.paddingY = 0;
    markdown.defaultTextStyle = {
      ...markdown.defaultTextStyle,
      bgColor: (text) => (themes.get(markdown) ?? theme).style(text, { bg: USER_MESSAGE_BG }),
    };
  }
  markdown.invalidate?.();
}
