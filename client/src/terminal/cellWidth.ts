/**
 * Terminal cell width of one code point: 0 (combining / zero-width), 1, or 2
 * (East Asian wide and fullwidth, emoji). An approximation of wcwidth, good
 * enough to decide where rows wrap on a phone.
 */
export function codePointWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x0300) return 1; // ASCII and Latin-1 fast path
  if (isZeroWidth(cp)) return 0;
  if (isWide(cp)) return 2;
  return 1;
}

export function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x0e31 && cp <= 0x0e3a && cp !== 0x0e32 && cp !== 0x0e33) ||
    (cp >= 0x0e47 && cp <= 0x0e4e) ||
    (cp >= 0x1160 && cp <= 0x11ff) || // Hangul jungseong / jongseong
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space, joiners, marks
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0xfeff ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul jamo leading consonants
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 ||
    cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x16fe0 && cp <= 0x18aff) ||
    (cp >= 0x1b000 && cp <= 0x1b2ff) ||
    cp === 0x1f004 ||
    cp === 0x1f0cf ||
    cp === 0x1f18e ||
    (cp >= 0x1f191 && cp <= 0x1f19a) ||
    (cp >= 0x1f200 && cp <= 0x1f251) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // pictographs, emoticons
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extensions B and later
  );
}
