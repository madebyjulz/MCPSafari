// Filtering shared by the console and network reads.

/**
 * Compiles a caller's filter pattern.
 *
 * Bounded regex subset: no repetitions, groups, or backreferences.
 * Without these constructs, matching work is bounded by pattern × input.
 */
export function compileRestrictedFilter(source: string): RegExp {
  const pattern = String(source);
  const unescaped = pattern.replace(/\\./g, "");

  if (pattern.length > 200 || /[()*+?{}]/.test(unescaped) || /\\[1-9k]/.test(pattern)) {
    throw new Error(
      "Unsupported filter: use at most 200 characters, with literals, dots, anchors, character classes, or alternation; no repetition, groups, or backreferences.",
    );
  }

  return new RegExp(pattern);
}

/** Removes from `buffer` exactly the entries in `returned`, keeping everything else in order. */
export function removeReturned<Entry>(buffer: Array<Entry>, returned: ReadonlyArray<Entry>): void {
  const removed = new Set<Entry | undefined>(returned);

  for (let i = buffer.length - 1; i >= 0; i--) {
    if (removed.has(buffer[i])) {
      buffer.splice(i, 1);
    }
  }
}
