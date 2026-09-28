export function prepareSpokenText(text: string): string {
  return text.replace(
    /\$\s*([a-z])\s*\^\s*\\text\{(st|nd|rd|th)\}\s*\$/gi,
    (_expression, letter: string, suffix: string) => `${letter}${suffix}`,
  );
}
