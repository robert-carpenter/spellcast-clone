export const LETTER_VALUES: Record<string, number> = {
  a: 1,
  b: 4,
  c: 5,
  d: 3,
  e: 1,
  f: 5,
  g: 3,
  h: 4,
  i: 1,
  j: 7,
  k: 6,
  l: 3,
  m: 4,
  n: 2,
  o: 1,
  p: 4,
  q: 8,
  r: 2,
  s: 2,
  t: 2,
  u: 4,
  v: 5,
  w: 5,
  x: 7,
  y: 4,
  z: 8
};

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const VOWELS = "AEIOU";
export const CONSONANTS = LETTERS.split("")
  .filter((ch) => !VOWELS.includes(ch))
  .join("");

export const GEM_CHANCE = 0.5;
export const TRIPLE_CHANCE = 0.12;

export interface LetterWeightEntry {
  letter: string;
  weight: number;
  cumulative: number;
}

const buildLetterWeights = (): LetterWeightEntry[] => {
  let cumulative = 0;
  return Object.entries(LETTER_VALUES).map(([letter, value]) => {
    const weight = value > 0 ? 1 / value : 0;
    cumulative += weight;
    return {
      letter: letter.toUpperCase(),
      weight,
      cumulative
    };
  });
};

export const LETTER_WEIGHTS = buildLetterWeights();
export const LETTER_WEIGHT_TOTAL =
  LETTER_WEIGHTS.length > 0 ? LETTER_WEIGHTS[LETTER_WEIGHTS.length - 1].cumulative : 0;
