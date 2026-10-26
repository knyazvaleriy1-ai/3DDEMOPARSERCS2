// Python semantics the JS parser needs to reproduce the Python parser's output
// exactly (rounding, string ordering, floor division and modulo).

/** Round half to even (numpy.round / Python round). */
export function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d === 0.5) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

/**
 * Python's round(x, nd). Exact for the values the parser rounds (float32
 * coordinates and tick counts over the tick rate), where x * 10**nd is exact.
 */
export function pyRound(x, nd = 0) {
  if (!Number.isFinite(x)) return x;
  const m = 10 ** nd;
  const r = roundHalfEven(x * m) / m;
  return r === 0 ? 0 : r; // no -0 in JSON
}

export function floorDiv(a, b) {
  return Math.floor(a / b);
}

/** Python's % (result takes the divisor's sign). */
export function pyMod(a, b) {
  const r = a % b;
  return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
}

/** Compare strings by code point, like Python (JS compares UTF-16 units). */
export function cmpStr(a, b) {
  if (a === b) return 0;
  const ia = a[Symbol.iterator](), ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next(), y = ib.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const cx = x.value.codePointAt(0), cy = y.value.codePointAt(0);
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

export function pyCapitalize(s) {
  const chars = [...s];
  if (!chars.length) return s;
  return chars[0].toUpperCase() + chars.slice(1).join('').toLowerCase();
}
