/** Adds a remembered fact to a bot memory document without dropping what it already holds. */
export function appendMemoryFact(existing: string, fact: string): string {
  const current = existing.trimEnd().replace(/\r\n/g, "\n");
  const next = fact.trim();
  const comparableFact = next.replace(/\r\n/g, "\n");
  if (
    !next ||
    `\n${current}\n`.includes(`\n${comparableFact}\n`) ||
    (!next.includes("\n") && current.split("\n").some((line) => line.trim() === next))
  )
    return existing;
  return existing ? `${existing}${existing.endsWith("\n") ? "" : "\n"}${next}\n` : `${next}\n`;
}
