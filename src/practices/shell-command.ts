/** Shell separators inside quoted arguments do not introduce a new command. */
export function invokesShellCommand(source: string, pattern: RegExp): boolean {
  let quote = "";
  let escaped = false;
  let comment = false;
  let command = "";

  for (const character of source) {
    if (comment && character !== "\n") {
      continue;
    }

    comment = false;

    if (escaped) {
      command += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      command += character;

      if (character === quote) {
        quote = "";
      }
    } else if (character === "'" || character === '"' || character === "`") {
      quote = character;
      command += character;
    } else if (character === "#" && (!command || /\s$/u.test(command))) {
      if (pattern.test(command)) {
        return true;
      }

      comment = true;
      command = "";
    } else if (/[;&|()\n\r]/u.test(character)) {
      if (pattern.test(command)) {
        return true;
      }

      command = "";
    } else {
      command += character;
    }
  }

  return pattern.test(command);
}
