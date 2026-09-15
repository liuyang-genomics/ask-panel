/**
 * Argument parsing.
 *
 * Split out because this is where a real bug lived: the parser assumed every
 * `--flag` consumed the next token, so a boolean flag ate whatever followed and
 * `run --continue "my question"` silently lost the question and fell through to
 * reading stdin. Argument order must never change meaning, so the set of
 * value-taking flags is declared rather than guessed.
 */

export const VALUE_FLAGS = new Set(['port', 'state', 'archive-dir', 'sites', 'timeout', 'out', 'from']);

/** Tokens that are not flags and not a flag's value. */
export function positionalArgs(tokens, valueFlags = VALUE_FLAGS) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) { if (valueFlags.has(t.slice(2))) i++; continue; }
    out.push(t);
  }
  return out;
}

export function parser(argv) {
  return {
    flag: (name, def) => {
      const i = argv.indexOf('--' + name);
      return i === -1 ? def : argv[i + 1];
    },
    has: (name) => argv.includes('--' + name),
    positional: (tokens) => positionalArgs(tokens),
  };
}
