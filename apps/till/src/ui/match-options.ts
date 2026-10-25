/**
 * Suggestions for what has been typed so far: names that start with it come first, then
 * names that contain it, each in their original order. Case is ignored, so "gsk" still
 * offers "GSK" (picking it fixes the spelling). An empty box offers everything. A name
 * typed exactly is left out, since there is nothing left to suggest.
 */
export function matchOptions(options: readonly string[], typed: string, limit = 50): string[] {
  const text = typed.trim();
  if (!text) return options.slice(0, limit);
  const lower = text.toLocaleLowerCase();
  const starts: string[] = [];
  const contains: string[] = [];
  for (const option of options) {
    if (option === text) continue;
    const name = option.toLocaleLowerCase();
    if (name.startsWith(lower)) starts.push(option);
    else if (name.includes(lower)) contains.push(option);
  }
  return [...starts, ...contains].slice(0, limit);
}
