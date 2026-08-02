// Parser for the global `--state-dir` option. Separate module so it stays
// unit-testable -- codex-companion.mjs calls main() at import time.

/**
 * Strip a leading `--state-dir <path>` (or `--state-dir=<path>`) from argv.
 *
 * The option is global, so it is removed before subcommand dispatch. Only the
 * leading options segment is scanned: `task` and `adversarial-review` take free
 * text that may itself mention `--state-dir`, and scanning all of argv would eat
 * the next word as the value or throw on a trailing mention.
 *
 * @param {string[]} argv
 * @returns {{ stateDir: string | null, rest: string[] }}
 */
export function extractStateDir(argv) {
  let stateDir = null;
  const rest = [];
  let index = 0;

  for (; index < argv.length; index += 1) {
    const token = argv[index];

    // `--` ends option parsing; everything from here on is positional.
    if (token === "--") {
      break;
    }

    if (token === "--state-dir") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("Missing value for --state-dir");
      }
      stateDir = value;
      index += 1;
      continue;
    }

    if (token.startsWith("--state-dir=")) {
      stateDir = token.slice("--state-dir=".length);
      if (!stateDir) {
        throw new Error("Missing value for --state-dir");
      }
      continue;
    }

    // First non-option token: prompt text starts here. Stop scanning and leave
    // the remainder untouched.
    if (typeof token !== "string" || !token.startsWith("-") || token === "-") {
      break;
    }

    // Some other option (--json, --enable-review-gate, ...). It belongs to the
    // subcommand, so carry it through -- only --state-dir is consumed here.
    rest.push(token);
  }

  return { stateDir, rest: rest.concat(argv.slice(index)) };
}
