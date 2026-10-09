/**
 * Two addresses side by side, with the characters that differ marked (FEATURES' rule: the attack
 * is a look-alike, and the short 0x1234…abcd form hides exactly the part an attacker changes).
 * Compared position by position, ignoring letter case (an address does not depend on it).
 */
export type Part = { text: string; differs: boolean };

export function markDifferences(shown: string, against: string): Part[] {
  const parts: Part[] = [];
  for (let i = 0; i < shown.length; i++) {
    const ch = shown[i] ?? '';
    const differs = ch.toLowerCase() !== (against[i] ?? '').toLowerCase();
    const last = parts.at(-1);
    if (last && last.differs === differs) last.text += ch;
    else parts.push({ text: ch, differs });
  }
  return parts;
}
