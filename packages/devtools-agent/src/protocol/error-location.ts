/** Coordinates are 1-based; columns count UTF-16 code units, with tabs counting as one. */
export interface ErrorLocation {
  line: number;
  column?: number;
}

/** Keep native located messages/stacks intact and fill a missing location only once. */
export function appendErrorLocation(message: string, location?: ErrorLocation): string {
  if (
    !location ||
    !Number.isSafeInteger(location.line) ||
    location.line < 1 ||
    /(?:^|\n)\s*at\s|(?:^|\n)[^\n]*:\d+:\d+\)?\s*$/m.test(message) ||
    /\bline \d+(?:, column \d+)?\)/.test(message)
  )
    return message;
  const column =
    typeof location.column === 'number' &&
    Number.isSafeInteger(location.column) &&
    location.column >= 1
      ? `, column ${location.column}`
      : '';
  return `${message} (line ${location.line}${column})`;
}
