/**
 * Characters a person cannot see, and letters that look like others (9 Oct). An invoice can carry
 * text no person reads: characters with no width, characters that reverse the order a person reads
 * (so what is shown differs from what a machine parses), and Unicode "tag" characters that encode a
 * whole sentence invisibly (ASCII smuggling, read by models). And a number or a name can swap a
 * Latin letter for one from another alphabet that looks the same. Each is found here, in code.
 */

/** Characters with no visible glyph in an invoice, by code point, with what they do. */
const NAMES: Record<number, string> = {
  0x00ad: 'soft hyphen',
  0x034f: 'combining grapheme joiner',
  0x061c: 'Arabic letter mark (changes reading direction)',
  0x115f: 'Hangul choseong filler',
  0x1160: 'Hangul jungseong filler',
  0x17b4: 'Khmer vowel inherent aq',
  0x17b5: 'Khmer vowel inherent aa',
  0x180e: 'Mongolian vowel separator',
  0x200b: 'zero width space',
  0x200c: 'zero width non-joiner',
  0x200d: 'zero width joiner',
  0x200e: 'left-to-right mark',
  0x200f: 'right-to-left mark',
  0x202a: 'left-to-right embedding',
  0x202b: 'right-to-left embedding',
  0x202c: 'pop directional formatting',
  0x202d: 'left-to-right override',
  0x202e: 'right-to-left override (reverses the text a person sees)',
  0x2060: 'word joiner',
  0x2061: 'function application',
  0x2062: 'invisible times',
  0x2063: 'invisible separator',
  0x2064: 'invisible plus',
  0x2066: 'left-to-right isolate',
  0x2067: 'right-to-left isolate',
  0x2068: 'first strong isolate',
  0x2069: 'pop directional isolate',
  0x206a: 'inhibit symmetric swapping',
  0x206b: 'activate symmetric swapping',
  0x206c: 'inhibit Arabic form shaping',
  0x206d: 'activate Arabic form shaping',
  0x206e: 'national digit shapes',
  0x206f: 'nominal digit shapes',
  0x3164: 'Hangul filler',
  0xfeff: 'zero width no-break space',
  0xffa0: 'halfwidth Hangul filler',
};

const isTag = (cp: number) => cp >= 0xe0000 && cp <= 0xe007f;
const isInvisible = (cp: number) => cp in NAMES || isTag(cp);

const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

export type Invisible = { codePoint: string; name: string; count: number };

/** Every invisible character in the text, by code point, in the order first seen. */
export function invisibleIn(text: string): Invisible[] {
  const seen = new Map<number, number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isInvisible(cp)) seen.set(cp, (seen.get(cp) ?? 0) + 1);
  }
  return [...seen].map(([cp, count]) => ({
    codePoint: hex(cp),
    name: NAMES[cp] ?? 'tag character (invisible; can spell out text a model reads)',
    count,
  }));
}

/** The text with every invisible character taken out, so the fields around them can be read. */
export const withoutInvisible = (text: string) =>
  Array.from(text)
    .filter((ch) => !isInvisible(ch.codePointAt(0) ?? 0))
    .join('');

/** Sentences spelled in tag characters (U+E0020 to U+E007E stand for ASCII), decoded. */
export function smuggledText(text: string): string[] {
  const out: string[] = [];
  let run = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xe0020 && cp <= 0xe007e) run += String.fromCharCode(cp - 0xe0000);
    else if (run) {
      out.push(run);
      run = '';
    }
  }
  if (run) out.push(run);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/** The alphabets whose letters can pass for Latin ones in an invoice number or a name. */
const SCRIPTS: [RegExp, string][] = [
  [/\p{Script=Greek}/u, 'Greek'],
  [/\p{Script=Cyrillic}/u, 'Cyrillic'],
  [/\p{Script=Armenian}/u, 'Armenian'],
  [/\p{Script=Cherokee}/u, 'Cherokee'],
];

/**
 * Letters from another alphabet mixed into Latin text ("ΚS-1001" with a Greek kappa): each as
 * "U+039A GREEK". Text written wholly in another alphabet is left alone: that is a language, not
 * a trick.
 */
export function lookAlikesIn(text: string): string[] {
  if (!/\p{Script=Latin}/u.test(text)) return [];
  const out: string[] = [];
  for (const ch of new Set(text)) {
    const script = SCRIPTS.find(([re]) => re.test(ch));
    if (script) out.push(`${hex(ch.codePointAt(0) ?? 0)} ${script[1].toUpperCase()} "${ch}"`);
  }
  return out;
}
