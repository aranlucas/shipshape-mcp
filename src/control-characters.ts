function isAsciiControl(character: string): boolean {
  const codePoint = character.codePointAt(0);

  return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
}

export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    if (isAsciiControl(character)) {
      return true;
    }
  }

  return false;
}

export function stripControlCharacters(value: string): string {
  let result = "";

  for (const character of value) {
    if (!isAsciiControl(character)) {
      result += character;
    }
  }

  return result;
}
