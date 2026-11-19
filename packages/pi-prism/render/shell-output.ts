/**
 * What a shell command printed, when its command says so: a range of one file (`cat`, `head`,
 * `sed -n 'A,Bp'`, `nl`, …) or grep-style matches (`rg`, `grep`, `git grep`, `ag`). The command
 * decides what the output can be; the output is never sniffed on its own, so a log that happens to
 * start with `12:34:56` stays a log. Pure: no I/O, no globals.
 */

/** One output line, read through its command. */
export type ShellLine =
  /** File content: its code without any prefix, its number in the file and the file it came from. */
  | {
      kind: "code";
      code: string;
      number?: number;
      path?: string;
      language?: string;
      /** Not the next line of the file after the line before it: grep skipped lines between them. */
      jump?: boolean;
    }
  /** Output the command explains nothing about, such as pi's note that it cut the output. */
  | { kind: "plain"; text: string }
  /** grep's `--` between groups of matches that are not adjacent in the file. */
  | { kind: "divider" };

export interface ShellView {
  lines: ShellLine[];
  /**
   * The numbers count consecutive lines of one file, so a gap between two numbered rows is a run
   * of hidden lines. grep's numbers jump wherever it skipped non-matching lines, so they are not.
   */
  contiguous: boolean;
  /** Lines name their files: show a path row where the file changes. */
  paths: boolean;
}

export interface ShellViewOptions {
  /** Numbers that count from the command's first line need the whole output from its start. */
  complete: boolean;
  languageFromPath?: (path: string) => string | undefined;
  /** A language for a file whose name says nothing, from its content (JSON). */
  sniff?: (text: string) => string | undefined;
}

// ---------------------------------------------------------------------------------------------
// Command words

interface Word {
  text: string;
  /** Unquoted glob characters or a variable: the shell expands it to something else. */
  dynamic: boolean;
}

type Token = { word: Word } | { op: string } | { redirect: string; target?: string };

const OPERATOR = /^(?:\|\||&&|\|&|;;|[|;&()<>`\n])/;
const REDIRECT = /^(\d*)(>>|>|<)(&\d*-?)?/;

/**
 * Shell words, quote-aware: a `|` inside a grep pattern is part of the pattern. Undefined for
 * anything that runs other code to build its words (`$(…)`, backticks).
 */
function tokenize(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let i = 0;
  while (i < command.length) {
    const char = command[i]!;
    if (char === " " || char === "\t") {
      i++;
      continue;
    }
    if (char === "\\" && command[i + 1] === "\n") {
      i += 2;
      continue;
    }
    const rest = command.slice(i);
    const redirect = REDIRECT.exec(rest);
    if (redirect && (redirect[1] || !/^\d/.test(rest))) {
      i += redirect[0].length;
      if (redirect[3]) {
        tokens.push({ redirect: `${redirect[1]}${redirect[2]}`, target: redirect[3] });
        continue;
      }
      while (command[i] === " ") i++;
      const target = readWord(command, i);
      if (!target) return undefined;
      i = target.end;
      tokens.push({ redirect: `${redirect[1]}${redirect[2]}`, target: target.word.text });
      continue;
    }
    const op = OPERATOR.exec(rest);
    if (op) {
      if (op[0] === "`") return undefined;
      tokens.push({ op: op[0] });
      i += op[0].length;
      continue;
    }
    const word = readWord(command, i);
    if (!word) return undefined;
    tokens.push({ word: word.word });
    i = word.end;
  }
  return tokens;
}

function readWord(command: string, from: number): { word: Word; end: number } | undefined {
  let text = "";
  let dynamic = false;
  let i = from;
  while (i < command.length) {
    const char = command[i]!;
    if (/[\s|&;<>()]/.test(char)) break;
    if (char === "`") return undefined;
    if (char === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return undefined;
      text += command.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (char === '"') {
      i++;
      while (i < command.length && command[i] !== '"') {
        const inner = command[i]!;
        if (inner === "`" || (inner === "$" && command[i + 1] === "(")) return undefined;
        if (inner === "$") dynamic = true;
        if (inner === "\\" && /["\\$`]/.test(command[i + 1] ?? "")) i++;
        text += command[i] ?? "";
        i++;
      }
      if (command[i] !== '"') return undefined;
      i++;
      continue;
    }
    if (char === "\\") {
      text += command[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (char === "$") {
      if (command[i + 1] === "(") return undefined;
      dynamic = true;
    }
    if (/[*?[{]/.test(char)) dynamic = true;
    text += char;
    i++;
  }
  return i === from ? undefined : { word: { text, dynamic }, end: i };
}

/**
 * The pipeline whose output the row shows, one word list per stage, after any `cd DIR &&`.
 * stderr may go to /dev/null or join stdout; any other list, redirect or subshell is not read.
 */
function pipeline(command: string): Word[][] | undefined {
  const tokens = tokenize(command.trim());
  if (!tokens?.length) return undefined;
  const stages: Word[][] = [[]];
  for (const token of tokens) {
    if ("word" in token) stages.at(-1)!.push(token.word);
    else if ("redirect" in token) {
      if (token.redirect !== "2>" || (token.target !== "/dev/null" && token.target !== "&1")) return undefined;
    } else if (token.op === "|") stages.push([]);
    else if (token.op === "&&") {
      const [cd, dir, ...rest] = stages.at(-1)!;
      if (stages.length !== 1 || cd?.text !== "cd" || cd.dynamic || !dir || rest.length) return undefined;
      stages[0] = [];
    } else return undefined;
  }
  return stages.every((stage) => stage.length && !stage[0]!.dynamic) ? stages : undefined;
}

// ---------------------------------------------------------------------------------------------
// Options

/**
 * One command's options: `-abc` clusters, `-A3` and `-A 3`, `--name=value` and `--name value`.
 * `takes` names the options that take a value; `--` ends the options. Undefined for an option
 * the caller does not know, so an unfamiliar flag never changes the output's shape unseen.
 */
function parseOptions(
  words: Word[],
  takes: (name: string) => boolean,
  accept: (name: string, value?: string) => boolean,
): Word[] | undefined {
  const operands: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const { text } = words[i]!;
    if (text === "--") {
      operands.push(...words.slice(i + 1));
      break;
    }
    if (text.startsWith("--")) {
      const eq = text.indexOf("=");
      const name = eq < 0 ? text : text.slice(0, eq);
      let value = eq < 0 ? undefined : text.slice(eq + 1);
      if (value === undefined && takes(name)) value = words[++i]?.text;
      if ((takes(name) && value === undefined) || !accept(name, value)) return undefined;
    } else if (/^-\d+$/.test(text)) {
      if (!accept("-NUM", text.slice(1))) return undefined;
    } else if (text.startsWith("-") && text.length > 1) {
      for (let j = 1; j < text.length; j++) {
        const name = `-${text[j]}`;
        if (takes(name)) {
          const value = j + 1 < text.length ? text.slice(j + 1) : words[++i]?.text;
          if (value === undefined || !accept(name, value)) return undefined;
          break;
        }
        if (!accept(name)) return undefined;
      }
    } else operands.push(words[i]!);
  }
  return operands;
}

const set = (names: string) => new Set(names.split(" "));

/** A count of lines: `-n 20`, `-20`, `--lines=20`; `+K` from line K when `plus` is allowed. */
function lineCount(value: string | undefined, plus: boolean): { from?: number } | undefined {
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value)) return {};
  const from = /^\+(\d+)$/.exec(value);
  return plus && from ? { from: Math.max(1, Number(from[1])) } : undefined;
}

/**
 * `head`/`tail` options. A `head` keeps the first line; a `tail` loses it, unless it reads
 * `tail -n +K`, which starts at line K. Undefined for byte counts, following, several files.
 */
function headTail(words: Word[]): { operands: Word[]; from?: number } | undefined {
  const tail = words[0]!.text === "tail";
  let from: number | undefined = tail ? undefined : 1;
  const operands = parseOptions(
    words.slice(1),
    (name) => name === "-n" || name === "--lines",
    (name, value) => {
      const count = name === "-NUM" ? {} : name === "-n" || name === "--lines" ? lineCount(value, tail) : undefined;
      if (!count) return false;
      from = count.from ?? (tail ? undefined : 1);
      return true;
    },
  );
  return operands && { operands, ...(from === undefined ? {} : { from }) };
}

/** `sed -n` programs that print one range: `A,Bp`, `Ap`, `A,$p`, `A,+Np`. */
function sedFrom(words: Word[]): { operands: Word[]; from: number } | undefined {
  let quiet = false;
  const operands = parseOptions(
    words.slice(1),
    () => false,
    (name) => {
      quiet ||= name === "-n" || name === "--quiet" || name === "--silent";
      return quiet;
    },
  );
  if (!quiet || !operands?.length) return undefined;
  const range = /^(\d+)(?:,(?:\d+|\$|\+\d+))?p$/.exec(operands[0]!.text);
  return range ? { operands: operands.slice(1), from: Math.max(1, Number(range[1])) } : undefined;
}

/** `awk 'NR>=A && NR<=B'`, with an optional `{print}`: the line it starts at. */
function awkFrom(words: Word[]): { operands: Word[]; from: number } | undefined {
  const [program, ...operands] = words.slice(1);
  if (!program || program.text.startsWith("-")) return undefined;
  const conditions = program.text.replace(/\s+/g, "").replace(/\{print(?:\$0)?;?\}$/, "");
  let from = 1;
  for (const condition of conditions.split("&&")) {
    const match = /^F?NR(>=|>|==|<=|<)(\d+)$/.exec(condition);
    if (!match) return undefined;
    const value = Number(match[2]);
    if (match[1] === ">=" || match[1] === "==") from = Math.max(from, value);
    else if (match[1] === ">") from = Math.max(from, value + 1);
  }
  return { operands, from };
}

/** `bat` with its decorations off: `-p`, `--plain` or `--style=plain`; `-r A:B` starts at A. */
function batFrom(words: Word[]): { operands: Word[]; from: number } | undefined {
  let plain = false;
  let from = 1;
  const operands = parseOptions(
    words.slice(1),
    (name) => ["-r", "--line-range", "--style", "--paging", "--color"].includes(name),
    (name, value) => {
      if (name === "-p" || name === "--plain") plain = true;
      else if (name === "--style") plain ||= value === "plain";
      else if (name === "-r" || name === "--line-range") {
        const range = /^(\d*):(\d*)$/.exec(value ?? "");
        if (!range) return false;
        from = Math.max(1, Number(range[1] || 1));
      } else if (name === "--paging" || name === "-P") return name === "-P" || value === "never";
      else if (name !== "--color") return false;
      return true;
    },
  );
  return plain && operands ? { operands, from } : undefined;
}

// ---------------------------------------------------------------------------------------------
// Single-file commands

interface FileSource {
  path: string;
  /** The output's first line, when the command fixes it. */
  from?: number;
  /** `nl` and `cat -n` print each line's number before a tab. */
  numbered?: boolean;
}

/** The first stage, when it prints one literal file or a range of it. */
function fileSource(words: Word[]): FileSource | undefined {
  const name = words[0]!.text;
  let source: { operands: Word[]; from?: number; numbered?: boolean } | undefined;
  if (name === "cat") {
    let numbered = false;
    const operands = parseOptions(
      words.slice(1),
      () => false,
      (flag) => (numbered = flag === "-n"),
    );
    source = operands && { operands, from: 1, numbered };
  } else if (name === "head" || name === "tail") source = headTail(words);
  else if (name === "sed") source = sedFrom(words);
  else if (name === "awk") source = awkFrom(words);
  else if (name === "bat") source = batFrom(words);
  else if (name === "nl") {
    // Its own numbers lead each line; a custom separator would hide where they end.
    const operands = parseOptions(
      words.slice(1),
      (flag) => /^-[bnwvi]$/.test(flag),
      (flag) => /^-[bnwvi]$/.test(flag),
    );
    source = operands && { operands, numbered: true };
  }
  if (!source || source.operands.length !== 1 || source.operands[0]!.dynamic) return undefined;
  return {
    path: source.operands[0]!.text,
    ...(source.from === undefined ? {} : { from: source.from }),
    ...(source.numbered ? { numbered: true } : {}),
  };
}

/** A later stage that keeps a range of its input: where that range starts, given the input's start. */
function narrow(words: Word[], from: number | undefined): { from?: number } | undefined {
  const name = words[0]!.text;
  let kept: { operands: Word[]; from?: number } | undefined;
  if (name === "head" || name === "tail") kept = headTail(words);
  else if (name === "sed") kept = sedFrom(words);
  else if (name === "awk") kept = awkFrom(words);
  else if (name === "cat" && words.length === 1) kept = { operands: [], from: 1 };
  if (!kept || kept.operands.length) return undefined;
  return from === undefined || kept.from === undefined ? {} : { from: from + kept.from - 1 };
}

const NUMBERED_LINE = /^ *(\d+) *\t(.*)$/;

function fileView(source: FileSource, lines: string[], from: number | undefined, options: ShellViewOptions): ShellView {
  const numbered = lines.map((line) => (source.numbered ? NUMBERED_LINE.exec(line) : null));
  const text = lines.map((line, index) => numbered[index]?.[2] ?? line).join("\n");
  const language = options.languageFromPath?.(source.path) ?? options.sniff?.(text);
  return {
    lines: lines.map((line, index): ShellLine => {
      const match = numbered[index];
      if (source.numbered) {
        if (match) return { kind: "code", code: match[2] ?? "", number: Number(match[1]), ...lang(language) };
        // `nl` leaves blank lines unnumbered; anything else it did not write.
        return line.trim() ? { kind: "plain", text: line } : { kind: "code", code: "", ...lang(language) };
      }
      return { kind: "code", code: line, ...(from === undefined ? {} : { number: from + index }), ...lang(language) };
    }),
    contiguous: true,
    paths: false,
  };
}

const lang = (language: string | undefined) => (language ? { language } : {});

// ---------------------------------------------------------------------------------------------
// grep-style commands

interface GrepFormat {
  numbers: boolean;
  /** Whether lines start with their file: decided by the command, or by the output when it cannot. */
  paths: boolean | undefined;
  /** Context lines (`-A`, `-B`, `-C`) and `--` between groups. */
  context: boolean;
  /** The one operand, when there is exactly one: the file every line comes from, or the directory searched. */
  operand?: Word;
  /** ag writes `path:N-` before a context line where grep writes `path-N-`. */
  ag?: boolean;
}

interface GrepSpec {
  /** Options that take a value and change nothing about a line's prefix. */
  values: Set<string>;
  /** Options without a value that change nothing about a line's prefix. */
  flags: Set<string>;
  numbers: Set<string>;
  noNumbers: Set<string>;
  paths: Set<string>;
  noPaths: Set<string>;
  recursive: Set<string>;
  context: Set<string>;
  /** Numbers are on unless an option turns them off. */
  numbersByDefault?: boolean;
}

const CONTEXT = set("-A -B -C --context --after-context --before-context");

const GREP: GrepSpec = {
  values: set("-e -f -m -D --regexp --file --max-count --include --exclude --exclude-dir --exclude-from --label"),
  flags: set(
    "-i -y -w -x -F -E -G -P -v -s -a -I -U --ignore-case --no-ignore-case --word-regexp --line-regexp " +
      "--fixed-strings --extended-regexp --basic-regexp --perl-regexp --invert-match --no-messages --text " +
      "--color --colour --binary-files --line-buffered",
  ),
  numbers: set("-n --line-number"),
  noNumbers: new Set(),
  paths: set("-H --with-filename"),
  noPaths: set("-h --no-filename"),
  recursive: set("-r -R --recursive --dereference-recursive"),
  context: CONTEXT,
};

const RG: GrepSpec = {
  values: set(
    "-e -f -g -t -T -m -M -j -E -r -d --regexp --file --glob --iglob --type --type-not --type-add --max-count " +
      "--max-columns --threads --encoding --replace --max-depth --max-filesize --sort --sortr --engine --ignore-file " +
      "--color --colors --pre --pre-glob",
  ),
  flags: set(
    "-i -s -S -w -x -F -P -U -v -a -L -u -z -. --ignore-case --case-sensitive --smart-case --word-regexp " +
      "--line-regexp --fixed-strings --pcre2 --multiline --multiline-dotall --invert-match --text --follow " +
      "--hidden --no-ignore --no-ignore-vcs --no-ignore-parent --no-ignore-dot --no-ignore-global " +
      "--no-ignore-exclude --no-ignore-files --no-messages --no-heading --no-config --trim --crlf --search-zip " +
      "--binary --one-file-system --sort-files --no-require-git --max-columns-preview --no-unicode",
  ),
  numbers: set("-n --line-number"),
  noNumbers: set("-N --no-line-number"),
  paths: set("-H --with-filename"),
  noPaths: set("-I --no-filename"),
  recursive: new Set(),
  context: CONTEXT,
};

const GIT_GREP: GrepSpec = {
  values: set("-e -f --max-depth --threads"),
  flags: set(
    "-i -w -v -E -F -G -P -I -a -r --ignore-case --word-regexp --invert-match --extended-regexp --fixed-strings " +
      "--basic-regexp --perl-regexp --untracked --cached --no-index --recurse-submodules --full-name --color " +
      "--no-color --text --exclude-standard --no-exclude-standard --textconv --no-textconv",
  ),
  numbers: set("-n --line-number"),
  noNumbers: new Set(),
  paths: set("-H"),
  noPaths: set("-h"),
  recursive: new Set(),
  context: CONTEXT,
};

const AG: GrepSpec = {
  values: set("-G -m --ignore --ignore-dir --depth --file-search-regex --max-count --color-match --color-path"),
  flags: set(
    "-i -s -S -Q -w -v -a -u -U -f -t --ignore-case --case-sensitive --smart-case --literal --word-regexp " +
      "--invert-match --all-types --unrestricted --skip-vcs-ignores --follow --all-text --hidden --nocolor " +
      "--color --nogroup --noheading --nobreak --search-zip --silent",
  ),
  numbers: set("--numbers"),
  noNumbers: set("--nonumbers"),
  paths: set("--filename"),
  noPaths: set("--nofilename"),
  recursive: new Set(),
  context: CONTEXT,
  // ag numbers the lines of the files it searches, and leaves them off only for stdin.
  numbersByDefault: true,
};

/** The grep at the head of the pipeline: how its lines are prefixed, from its options and operands. */
function grepFormat(words: Word[]): GrepFormat | undefined {
  let name = words[0]!.text;
  let rest = words.slice(1);
  if (name === "git") {
    // `git --no-pager -C dir grep …`: git's own options come before the subcommand.
    let i = 0;
    while (i < rest.length && rest[i]!.text !== "grep") {
      const option = rest[i]!.text;
      if (option === "-C" || option === "-c") i += 2;
      else if (option === "--no-pager" || option === "-P" || option === "--paginate") i++;
      else return undefined;
    }
    if (i >= rest.length) return undefined;
    name = "git grep";
    rest = rest.slice(i + 1);
  }
  const spec = name === "rg" ? RG : name === "git grep" ? GIT_GREP : name === "ag" ? AG : GREP;
  if (!["grep", "egrep", "fgrep", "rg", "git grep", "ag"].includes(name)) return undefined;
  let numbers = !!spec.numbersByDefault;
  let paths: boolean | undefined;
  let recursive = false;
  let context = false;
  let pattern = false;
  const operands = parseOptions(
    rest,
    (option) => spec.values.has(option) || spec.context.has(option),
    (option, value) => {
      if (option === "-NUM" || spec.context.has(option)) {
        if (!/^\d+$/.test(value ?? "")) return false;
        context ||= Number(value) > 0;
      } else if (spec.numbers.has(option)) numbers = true;
      else if (spec.noNumbers.has(option)) numbers = false;
      else if (spec.paths.has(option)) paths = true;
      else if (spec.noPaths.has(option)) paths = false;
      else if (spec.recursive.has(option)) recursive = true;
      else if (!spec.values.has(option) && !spec.flags.has(option)) return false;
      if (option === "-e" || option === "-f" || option === "--regexp" || option === "--file") pattern = true;
      // A colour name is fine; `--color` alone never reads the next word.
      return true;
    },
  );
  if (!operands) return undefined;
  const files = pattern ? operands : operands.slice(1);
  if (!pattern && !operands.length) return undefined;
  if (paths === undefined) {
    if (name === "git grep") paths = true;
    else if (files.length > 1 || recursive) paths = true;
    else if (files.length === 0) paths = name === "rg" || name === "ag" ? true : undefined;
    // One operand: one file prints bare lines, one directory or a glob prints paths. Undecided until the output.
  }
  // grep with no file and no -r reads stdin: not the head of this pipeline.
  if (files.length === 0 && paths === undefined) return undefined;
  return {
    numbers,
    paths,
    context,
    // git grep's operands are pathspecs or revisions, not the start of the paths it prints.
    ...(files.length === 1 && name !== "git grep" ? { operand: files[0]! } : {}),
    ...(name === "ag" ? { ag: true } : {}),
  };
}

/** Later stages that keep each line whole, so every kept line still says where it came from. */
function keepsLines(words: Word[]): boolean {
  const name = words[0]!.text;
  if (name === "head" || name === "tail") return headTail(words)?.operands.length === 0;
  if (name === "sort")
    return words.slice(1).every((word) => !/^-(?:[a-z]*o|-output)/i.test(word.text) && word.text.startsWith("-"));
  if (name === "uniq") return words.slice(1).every((word) => /^-[uid]+$/.test(word.text));
  if (name === "cat") return words.length === 1;
  if (name === "grep" || name === "egrep" || name === "fgrep" || name === "rg") {
    // A filter on the lines: no options that add a prefix or print something else.
    let pattern = false;
    const operands = parseOptions(
      words.slice(1),
      (option) => option === "-e" || option === "--regexp",
      (option) => {
        pattern ||= option === "-e" || option === "--regexp";
        return /^-[ivFEwxPGs]$/.test(option) || option === "-e" || option === "--regexp";
      },
    );
    return !!operands && operands.length === (pattern ? 0 : 1);
  }
  return false;
}

/** A path as grep prints it: not bare digits, so `12:34:56` never reads as a file named `12`. */
const isPath = (path: string) => !/^\d+$/.test(path);

/** The literal part of an operand, before any glob: what every path it expands to starts with. */
function operandPrefix(operand: Word | undefined): string | undefined {
  if (!operand) return undefined;
  if (!operand.dynamic) return operand.text;
  const glob = operand.text.search(/[*?[{$]/);
  return operand.text.slice(0, glob < 0 ? undefined : glob);
}

/**
 * The known paths `text` starts with, longest first: each ends just before a `:` or a `-`. Only
 * the first `longest` columns can hold one, so a long line costs no more than a short one.
 */
function* knownPrefixes(text: string, known: Set<string>, longest: number): Generator<string> {
  for (let end = Math.min(text.length - 1, longest); end > 0; end--) {
    const char = text[end];
    if ((char === ":" || char === "-") && known.has(text.slice(0, end))) yield text.slice(0, end);
  }
}

const pathAt = (line: ShellLine | undefined) => (line?.kind === "code" ? line.path : undefined);

function grepView(format: GrepFormat, lines: string[], options: ShellViewOptions): ShellView {
  const separator = (line: string) => format.context && line === "--";
  const candidates = lines.filter((line) => line.trim() && !separator(line));
  const prefix = operandPrefix(format.operand);
  let paths = format.paths;
  if (paths === undefined) {
    // One operand: a directory or a glob prints paths that start with it, one file prints none.
    paths = prefix
      ? candidates.length > 0 && candidates.every((line) => line.startsWith(prefix))
      : !(format.numbers && candidates.every((line) => /^\d+[:-]/.test(line)));
  }
  const fileLanguage = paths || !format.operand ? undefined : options.languageFromPath?.(format.operand.text);
  const language = (path: string | undefined) =>
    lang(path === undefined ? fileLanguage : options.languageFromPath?.(path));

  if (!paths) {
    const parsed = lines.map((line): ShellLine => {
      if (separator(line)) return { kind: "divider" };
      if (!format.numbers) return { kind: "code", code: line, ...language(undefined) };
      const match = (format.context ? /^(\d+)[:-](.*)$/ : /^(\d+):(.*)$/).exec(line);
      if (!match) return { kind: "plain", text: line };
      return { kind: "code", code: match[2]!, number: Number(match[1]), ...language(undefined) };
    });
    return { lines: markJumps(parsed, format), contiguous: false, paths: false };
  }

  // A match line names its file before a `:`. The first `:` followed by a number (or any `:`
  // without numbers) ends the path; a context line names it before a `-` and is read only
  // against paths a match line named, since a `-` is common inside a file name.
  const matchLine = format.numbers ? /^(.+?):(\d+):/ : /^(.+?):/;
  const named = new Set<string>();
  for (const line of candidates) {
    const path = matchLine.exec(line)?.[1];
    if (path && isPath(path) && (!prefix || path.startsWith(prefix))) named.add(path);
  }
  let longest = 0;
  for (const path of named) longest = Math.max(longest, path.length);
  // A context line whose code holds `:N:` reads as a match in a file named like `a.ts-3-…`: drop
  // that path. Without numbers nothing tells such a line from a file named with a `-`: keep it.
  const known = new Set(
    [...named].filter(
      (path) =>
        !format.numbers ||
        !format.context ||
        [...knownPrefixes(path, named, longest)].every((other) => !/^[-:]\d+-/.test(path.slice(other.length))),
    ),
  );
  const prefixed = format.numbers
    ? format.context
      ? format.ag
        ? /^[:-](\d+)[:-](.*)$/
        : /^([:-])(\d+)\1(.*)$/
      : /^:(\d+):(.*)$/
    : format.context
      ? /^[:-](.*)$/
      : /^:(.*)$/;

  const parsed = lines.map((line): ShellLine => {
    if (separator(line)) return { kind: "divider" };
    for (const path of knownPrefixes(line, known, longest)) {
      const match = prefixed.exec(line.slice(path.length));
      if (!match) continue;
      if (!format.numbers) return { kind: "code", code: match[1]!, path, ...language(path) };
      const [number, code] = format.ag || !format.context ? [match[1]!, match[2]!] : [match[2]!, match[3]!];
      return { kind: "code", code, number: Number(number), path, ...language(path) };
    }
    return { kind: "plain", text: line };
  });
  // Where the file changes, its path row separates the groups: the `--` between them goes.
  const next: Array<string | undefined> = [];
  for (let index = parsed.length - 1, path: string | undefined; index >= 0; index--) {
    next[index] = path;
    path = pathAt(parsed[index]) ?? path;
  }
  let previous: string | undefined;
  const kept = parsed.filter((line, index) => {
    previous = pathAt(line) ?? previous;
    return line.kind !== "divider" || !previous || !next[index] || previous === next[index];
  });
  return { lines: markJumps(kept, format), contiguous: false, paths: true };
}

/**
 * Where grep skipped lines of a file without a `--` to say so: numbers that do not follow on,
 * or, without numbers or context, every match, since matches are rarely adjacent.
 */
function markJumps(lines: ShellLine[], format: GrepFormat): ShellLine[] {
  let previous: ShellLine | undefined;
  return lines.map((line) => {
    const before = previous;
    previous = line;
    if (line.kind !== "code" || before?.kind !== "code") return line;
    const follows =
      line.number !== undefined && before.number !== undefined
        ? line.number === before.number + 1
        : format.context && !format.numbers;
    return follows ? line : { ...line, jump: true };
  });
}

// ---------------------------------------------------------------------------------------------

/**
 * pi's bash keeps the tail of a long output and says so last: its lines no longer start at the
 * command's first. Its partial results while running are cut the same way, without the note.
 */
const SHELL_TRUNCATED = /\n\n(\[Showing [^\n]*Full output: [^\n]*\])$/;
/** The note pi writes when it kept only the end of one long line: no line in it starts whole. */
const PARTIAL_LINE = /^\[Showing last [^\n]* of line \d+/;

/** How a shell command's output reads, when the command says; undefined for anything else. */
export function shellView(command: string, output: string, options: ShellViewOptions): ShellView | undefined {
  const stages = pipeline(command);
  if (!stages) return undefined;
  const cut = SHELL_TRUNCATED.exec(output);
  if (cut && PARTIAL_LINE.test(cut[1]!)) return undefined;
  const lines = (cut ? output.slice(0, cut.index) : output).split("\n");
  const trailer: ShellLine[] = cut ? [{ kind: "plain", text: cut[1]! }] : [];
  const [head, ...later] = stages;

  const grep = grepFormat(head!);
  if (grep) {
    if (!later.every(keepsLines)) return undefined;
    const view = grepView(grep, lines, options);
    return { ...view, lines: [...view.lines, ...trailer] };
  }

  const source = fileSource(head!);
  if (!source) return undefined;
  let from = source.from;
  for (const stage of later) {
    const kept = narrow(stage, from);
    if (!kept) return undefined;
    from = kept.from;
  }
  // Counting from the first line needs the output from its start.
  const view = fileView(source, lines, options.complete && !cut ? from : undefined, options);
  return { ...view, lines: [...view.lines, ...trailer] };
}

/**
 * Each code line's highlighted text, by output line. Consecutive lines of one file in one
 * language are highlighted as one source, so a string or a comment that spans them reads right;
 * a divider, a plain line or another file starts a new source.
 */
export function highlightShellLines(
  lines: ShellLine[],
  highlight: (source: string, language: string) => string[],
): Array<string | undefined> {
  const styled: Array<string | undefined> = Array.from({ length: lines.length });
  let start = 0;
  while (start < lines.length) {
    const first = lines[start]!;
    if (first.kind !== "code" || !first.language) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < lines.length) {
      const next = lines[end]!;
      if (next.kind !== "code" || next.jump || next.language !== first.language || next.path !== first.path) break;
      end++;
    }
    const group = lines.slice(start, end) as Array<Extract<ShellLine, { kind: "code" }>>;
    const rows = highlight(group.map((line) => line.code).join("\n"), first.language);
    group.forEach((_, index) => {
      styled[start + index] = rows[index];
    });
    start = end;
  }
  return styled;
}
