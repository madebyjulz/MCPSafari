// The command lines these scripts accept, and how they reject the rest, follow
// Python's argparse as the original scripts used it: positional arguments
// (optionally one subcommand), `-h`/`--help`, `--` ending options, usage and
// help text on the same streams with the same exit codes (help 0, usage error 2).
import { repr } from "./python.ts";

export interface Positional {
  readonly name: string;
  /** `nargs="+"`: one or more values. */
  readonly variadic?: boolean;
}

export interface Subcommand {
  readonly name: string;
  readonly positionals: readonly Positional[];
}

export interface Program {
  readonly prog: string;
  readonly description?: string;
  /** Either a subcommand, chosen by the first positional (`dest="command"`), or plain positionals. */
  readonly subcommands?: readonly Subcommand[];
  readonly positionals?: readonly Positional[];
}

export interface Exit {
  readonly kind: "exit";
  readonly code: number;
}

export type Parsed =
  | {
      readonly kind: "parsed";
      readonly command: string | undefined;
      readonly values: ReadonlyMap<string, readonly string[]>;
    }
  | Exit;

interface Parser {
  readonly prog: string;
  readonly description: string | undefined;
  readonly positionals: readonly Positional[];
  readonly subcommands: readonly Subcommand[] | undefined;
}

interface Collected {
  command: string | undefined;
  readonly values: Map<string, string[]>;
  readonly extras: string[];
}

type Token =
  | { readonly kind: "positional" }
  | { readonly kind: "unknown" }
  | { readonly kind: "help" }
  | { readonly kind: "explicit"; readonly value: string };

const NEGATIVE_NUMBER = /^-\p{Nd}+$|^-\p{Nd}*\.\p{Nd}+$/u;

/** Parse `argv` the way `ArgumentParser.parse_args` would, printing help or a usage error itself. */
export function parseArguments(program: Program, argv: readonly string[]): Parsed {
  const top: Parser = {
    prog: program.prog,
    description: program.description,
    positionals: program.subcommands === undefined ? (program.positionals ?? []) : [{ name: "command" }],
    subcommands: program.subcommands,
  };

  const collected: Collected = { command: undefined, values: new Map(), extras: [] };
  const code = parseInto(top, argv, collected);

  if (code !== undefined) return { kind: "exit", code };

  if (collected.extras.length > 0) return usageError(top, `unrecognized arguments: ${collected.extras.join(" ")}`);

  return { kind: "parsed", command: collected.command, values: collected.values };
}

function classify(arg: string): Token {
  if (arg === "" || arg === "-" || !arg.startsWith("-")) return { kind: "positional" };

  if (arg.startsWith("--")) {
    const equals = arg.indexOf("=");
    const option = equals === -1 ? arg : arg.slice(0, equals);

    // argparse accepts any unambiguous prefix of a long option.
    if (option.length >= 3 && "--help".startsWith(option)) {
      return equals === -1 ? { kind: "help" } : { kind: "explicit", value: arg.slice(equals + 1) };
    }
  } else if (arg[1] === "h") {
    return arg[2] === "=" ? { kind: "explicit", value: arg.slice(3) } : { kind: "help" };
  }

  if (NEGATIVE_NUMBER.test(arg) || arg.includes(" ")) return { kind: "positional" };

  return { kind: "unknown" };
}

/** Returns an exit code when parsing must stop, or undefined once every positional is filled. */
function parseInto(parser: Parser, argv: readonly string[], collected: Collected): number | undefined {
  let optionsEnded = false;
  let next = 0;
  let index = 0;

  const tokenAt = (position: number): Token => {
    const arg = argv[position] ?? "";

    return optionsEnded ? { kind: "positional" } : classify(arg);
  };

  while (index < argv.length) {
    const arg = argv[index] ?? "";

    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      index += 1;
      continue;
    }

    const token = tokenAt(index);

    switch (token.kind) {
      case "help":
        process.stdout.write(formatHelp(parser));

        return 0;
      case "explicit":
        return usageError(parser, `argument -h/--help: ignored explicit argument ${repr(token.value)}`).code;
      case "unknown":
        collected.extras.push(arg);
        index += 1;
        continue;
      case "positional":
        break;
    }

    const target = parser.positionals[next];

    if (target === undefined) {
      collected.extras.push(arg);
      index += 1;
      continue;
    }

    next += 1;

    if (parser.subcommands !== undefined) {
      const subcommand = parser.subcommands.find((candidate) => candidate.name === arg);

      if (subcommand === undefined) {
        const choices = parser.subcommands.map((candidate) => repr(candidate.name)).join(", ");

        return usageError(parser, `argument ${target.name}: invalid choice: ${repr(arg)} (choose from ${choices})`)
          .code;
      }

      collected.command = subcommand.name;

      const child: Parser = {
        prog: `${parser.prog} ${subcommand.name}`,
        description: undefined,
        positionals: subcommand.positionals,
        subcommands: undefined,
      };

      // The subcommand takes everything after its name; its leftovers come back as extras.
      return parseInto(child, argv.slice(index + 1), collected);
    }

    const values = [arg];

    index += 1;

    // nargs="+" takes the whole run of positionals, `--` included.
    while (target.variadic === true && index < argv.length) {
      if (!optionsEnded && argv[index] === "--") {
        optionsEnded = true;
        index += 1;
        continue;
      }

      if (tokenAt(index).kind !== "positional") break;

      values.push(argv[index] ?? "");
      index += 1;
    }

    collected.values.set(target.name, values);
  }

  const missing = parser.positionals.slice(next).map((positional) => positional.name);

  if (missing.length > 0) return usageError(parser, `the following arguments are required: ${missing.join(", ")}`).code;

  return undefined;
}

function usage(parser: Parser): string {
  const positionals =
    parser.subcommands === undefined
      ? parser.positionals.map((positional) =>
          positional.variadic === true ? `${positional.name} [${positional.name} ...]` : positional.name,
        )
      : [`${invocation(parser)[0] ?? ""} ...`];

  return `usage: ${[parser.prog, "[-h]", ...positionals].join(" ")}\n`;
}

/** How each positional is listed under "positional arguments". */
function invocation(parser: Parser): string[] {
  if (parser.subcommands !== undefined) return [`{${parser.subcommands.map(({ name }) => name).join(",")}}`];

  return parser.positionals.map(({ name }) => name);
}

const HELP_OPTION = "-h, --help";

function formatHelp(parser: Parser): string {
  const positionals = invocation(parser);
  const indent = 2;
  const widest = Math.max(HELP_OPTION.length, ...positionals.map((name) => name.length)) + indent;
  const helpPosition = Math.min(widest + 2, 24);
  const description = parser.description === undefined ? "" : `${parser.description}\n\n`;
  const listed = positionals.map((name) => `  ${name}\n`).join("");
  const option = `  ${HELP_OPTION.padEnd(helpPosition - indent - 2)}  show this help message and exit\n`;

  return `${usage(parser)}\n${description}positional arguments:\n${listed}\noptions:\n${option}`;
}

function usageError(parser: Parser, message: string): Exit {
  process.stderr.write(`${usage(parser)}${parser.prog}: error: ${message}\n`);

  return { kind: "exit", code: 2 };
}
