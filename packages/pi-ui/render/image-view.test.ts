import { describe, expect, test } from "bun:test";
import { centerImage } from "./image-view.ts";

describe("centering an image", () => {
  test("a small image sits in the middle of the rows and the columns it is given", () => {
    expect(centerImage(["<img>"], 11, 5)).toEqual(["", "", "   <img>"]);
    expect(centerImage(["a"], 10, 1)).toEqual(["    a"]);
  });

  test("an image taller than the room keeps its first row, and an odd surplus leans up", () => {
    expect(centerImage(["a", "b", "c"], 10, 3)).toEqual(["    a", "    b", "    c"]);
    expect(centerImage(["a", "b", "c"], 10, 4)).toEqual(["    a", "    b", "    c"]);
    expect(centerImage(["a", "b", "c", "d"], 10, 2)).toEqual(["    a", "    b", "    c", "    d"]);
  });

  test("a row wider than the columns keeps its opening: the terminal cuts the rest", () => {
    expect(centerImage(["12345"], 4, 1)).toEqual(["12345"]);
  });

  test("an escape takes no column: the row is placed by what it draws", () => {
    expect(centerImage(["\x1b[31mab\x1b[0m"], 6, 1)).toEqual(["  \x1b[31mab\x1b[0m"]);
  });

  test("an image is placed by the columns its escape names, not by what the string measures", () => {
    const kitty = "\x1b_Ga=T,f=100,q=2,C=1,c=40;AAAA\x1b\\";
    expect(centerImage(["", "", kitty], 100, 3)).toEqual([" ".repeat(30), " ".repeat(30), " ".repeat(30) + kitty]);
    const iterm = "\x1b[2A\x1b]1337;File=inline=1;size=4;width=40:AAAA\x07";
    expect(centerImage([iterm], 100, 1)).toEqual([" ".repeat(30) + iterm]);
  });
});
