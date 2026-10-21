/** Trims and collapses runs of whitespace: "  Panadol   Extra " → "Panadol Extra". */
export function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Case-insensitive key for matching names: "  GSK  Pakistan" → "gsk pakistan". */
export function nameKey(value: string): string {
  return cleanText(value).toLowerCase();
}

/** Splits "Amoxicillin + Clavulanic Acid" into ["Amoxicillin", "Clavulanic Acid"]. */
export function splitList(value: string, separator: string | RegExp = /\s*\+\s*/): string[] {
  return value
    .split(separator)
    .map(cleanText)
    .filter((part) => part.length > 0);
}

/** Naive English plural for unit names: Tablet → Tablets, Box → Boxes, Strip → Strips. */
export function pluralize(word: string, count: number): string {
  if (count === 1 || count === -1) return word;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}
