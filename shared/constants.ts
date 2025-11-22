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

export const LETTER_COUNTS: Record<string, number> = {
  a: 9,
  b: 2,
  c: 2,
  d: 4,
  e: 12,
  f: 2,
  g: 3,
  h: 2,
  i: 9,
  j: 1,
  k: 1,
  l: 4,
  m: 2,
  n: 6,
  o: 8,
  p: 2,
  q: 1,
  r: 6,
  s: 4,
  t: 6,
  u: 4,
  v: 2,
  w: 2,
  x: 1,
  y: 2,
  z: 1,
};

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const VOWELS = "AEIOU";
export const CONSONANTS = LETTERS.split("")
  .filter((ch) => !VOWELS.includes(ch))
  .join("");

export const GEM_CHANCE = 0.6;
export const TRIPLE_CHANCE = 0.12;
