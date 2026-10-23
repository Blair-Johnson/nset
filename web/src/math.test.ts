import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize, ema, makeInterpolator, type Interpolation, type Point, type XY } from './math.ts';

function near(actual: number | null, expected: number, tolerance = 2e-14): void {
  assert.notEqual(actual, null);
  assert.ok(Number.isFinite(actual));
  assert.ok(Math.abs(actual! - expected) <= tolerance * Math.max(Math.abs(expected), 1),
    `${actual} != ${expected}`);
}
function point(seq: number, step: number, timestamp: number, value: number): Point {
  return { seq, step, timestamp, value };
}
const kinds: Interpolation[] = ['linear', 'pchip'];

test('canonicalize: ascending selected axis, greatest seq wins, no mutation', () => {
  const source = [point(6, 2, 30, 6), point(7, 0, 20, 7), point(5, 2, 10, 5), point(4, 1, 20, 4)];
  const before = structuredClone(source);
  assert.deepEqual(canonicalize(source, 'step'), [[0, 7], [1, 4], [2, 6]]);
  assert.deepEqual(canonicalize(source, 'timestamp'), [[10, 5], [20, 7], [30, 6]]);
  assert.deepEqual(source, before);
  assert.deepEqual(canonicalize([], 'step'), []);
  assert.deepEqual(canonicalize([point(2, 0, 0, 1), point(2, 0, 0, 9)], 'step'), [[0, 9]]);
});

test('canonicalize validates all rows, including discarded and unselected fields', () => {
  for (const field of ['seq', 'step', 'timestamp', 'value'] as const) {
    for (const value of [NaN, Infinity, -Infinity]) {
      const bad = { ...point(1, 0, 0, 1), [field]: value };
      assert.throws(() => canonicalize([point(2, 0, 0, 2), bad], 'step'), RangeError);
    }
  }
  assert.throws(() => canonicalize([], 'bad' as 'step'), RangeError);
});

test('EMA uses the full observation sequence, not x distance or viewport', () => {
  const source: XY[] = [[-2, -4], [0, 4], [9, 0], [100, 8]];
  assert.deepEqual(ema(source, 0.5), [[-2, -4], [0, 0], [9, 0], [100, 4]]);
  assert.deepEqual(ema(source, 1), source);
  assert.notEqual(ema(source, 1)[0], source[0]);
  assert.deepEqual(ema([], 0.2), []);
  assert.deepEqual(ema([[0, -2]], 0.2), [[0, -2]]);
  assert.deepEqual(source, [[-2, -4], [0, 4], [9, 0], [100, 8]]);
  assert.equal(ema(source, 0.5)[3][1], 4);
  assert.equal(ema(source.slice(2), 0.5)[1][1], 4);
  assert.notEqual(ema(source, 0.5)[2][1], ema(source.slice(1), 0.5)[1][1]);
});

test('EMA rejects invalid alpha and keeps extreme opposite signs finite', () => {
  for (const alpha of [0, -1, 1.0001, NaN, Infinity]) assert.throws(() => ema([], alpha), RangeError);
  assert.deepEqual(ema([[0, -Number.MAX_VALUE], [1, Number.MAX_VALUE]], 0.5), [[0, -Number.MAX_VALUE], [1, 0]]);
});

for (const kind of kinds) {
  test(`${kind}: empty, singleton, exact endpoints and no extrapolation`, () => {
    const empty = makeInterpolator([], kind);
    assert.equal(empty.at(0), null);
    assert.deepEqual(empty.crossings(0), { points: [], plateaus: [] });
    const one = makeInterpolator([[3, -2]], kind);
    assert.equal(one.at(3), -2);
    assert.equal(one.at(3.001), null);
    assert.equal(one.at(2.999), null);
    assert.deepEqual(one.crossings(-2), { points: [3], plateaus: [] });
    assert.deepEqual(one.crossings(0), { points: [], plateaus: [] });
    const curve = makeInterpolator([[-2, -3], [0, 1], [5, 11]], kind);
    for (const [x, y] of [[-2, -3], [0, 1], [5, 11]]) assert.equal(curve.at(x), y);
    assert.equal(curve.at(-3), null);
    assert.equal(curve.at(6), null);
    near(curve.at(-1), -1);
    near(curve.at(3), 7);
    near(curve.crossings(0).points[0], -0.5);
  });

  test(`${kind}: two-point affine interpolation on irregular/negative x`, () => {
    const curve = makeInterpolator([[-5, 9], [3, -7]], kind);
    for (const x of [-5, -3.5, -1, 0, 2.5, 3]) near(curve.at(x), -2 * x - 1);
    assert.deepEqual(curve.crossings(9), { points: [-5], plateaus: [] });
    assert.deepEqual(curve.crossings(-7), { points: [3], plateaus: [] });
    near(curve.crossings(0).points[0], -0.5);
    assert.deepEqual(curve.crossings(10), { points: [], plateaus: [] });
  });

  test(`${kind}: all roots, tangencies, knot deduplication, sorted output`, () => {
    const curve = makeInterpolator([[0, 0], [1, 1], [2, 0], [3, -1], [4, 0], [5, 1]], kind);
    assert.deepEqual(curve.crossings(0), { points: [0, 2, 4], plateaus: [] });
    assert.deepEqual(curve.crossings(1), { points: [1, 5], plateaus: [] });
    assert.deepEqual(curve.crossings(-1), { points: [3], plateaus: [] });
    const roots = curve.crossings(0.5).points;
    assert.equal(roots.length, 3);
    assert.ok(roots[0] < roots[1] && roots[1] < roots[2]);
    for (const x of roots) near(curve.at(x), 0.5);
  });

  test(`${kind}: contiguous plateaus merge; plateau boundaries are not isolated roots`, () => {
    const curve = makeInterpolator([[-1, -1], [0, 0], [1, 0], [2, 0], [3, 1], [4, 0], [5, 0], [6, -1], [7, 0]], kind);
    assert.deepEqual(curve.crossings(0), { points: [7], plateaus: [[0, 2], [4, 5]] });
    assert.deepEqual(makeInterpolator([[0, 2], [1, 2], [10, 2]], kind).crossings(2),
      { points: [], plateaus: [[0, 10]] });
    const ends = makeInterpolator([[0, 0], [1, 0], [2, -1], [3, 0], [4, 0]], kind);
    assert.deepEqual(ends.crossings(0), { points: [], plateaus: [[0, 1], [3, 4]] });
    assert.equal(curve.at(0.37), 0);
    assert.equal(curve.at(4.79), 0);
  });

  test(`${kind}: copies input; finite validation and strict x order`, () => {
    const source: XY[] = [[0, 1], [1, 2]];
    const curve = makeInterpolator(source, kind);
    source[0][1] = 99;
    source.push([2, 100]);
    assert.equal(curve.at(0), 1);
    assert.equal(curve.at(2), null);
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => makeInterpolator([[bad, 0]], kind), RangeError);
      assert.throws(() => makeInterpolator([[0, bad]], kind), RangeError);
      assert.throws(() => curve.at(bad), RangeError);
      assert.throws(() => curve.crossings(bad), RangeError);
      assert.throws(() => makeInterpolator([], kind).at(bad), RangeError);
    }
    for (const bad of [[[0, 1], [0, 2]], [[1, 1], [0, 2]]] as XY[][]) {
      assert.throws(() => makeInterpolator(bad, kind), RangeError);
      assert.throws(() => ema(bad, 0.5), RangeError);
    }
    assert.throws(() => makeInterpolator([[-Number.MAX_VALUE, 0], [Number.MAX_VALUE, 1]], kind), /width/);
  });

  test(`${kind}: tiny representable grids and large offsets honor knots and roots`, () => {
    const tiny = makeInterpolator([[0, 0], [1e-200, 1e-200], [3e-200, 3e-200]], kind);
    assert.ok(Math.abs(tiny.at(0.5e-200)! / 0.5e-200 - 1) < 1e-14);
    assert.ok(Math.abs(tiny.crossings(0.5e-200).points[0] / 0.5e-200 - 1) < 1e-14);
    const x = 1e15;
    const offset = makeInterpolator([[x, -2], [x + 1, 0], [x + 4, 6]], kind);
    assert.equal(offset.at(x + 1), 0);
    assert.equal(offset.crossings(1).points[0], x + 1.5);
    const adjacent = makeInterpolator([[1, 0], [1 + Number.EPSILON, 1]], kind);
    assert.equal(adjacent.at(1), 0);
    assert.equal(adjacent.at(1 + Number.EPSILON), 1);
    assert.ok(Number.isFinite(adjacent.crossings(0.5).points[0]));
  });
}

test('linear: independent analytic roots on irregular, nonmonotonic grid', () => {
  const curve = makeInterpolator([[-3, -2], [-1, 2], [4, -3], [10, 3]], 'linear');
  assert.deepEqual(curve.crossings(0), { points: [-2, 1, 7], plateaus: [] });
  assert.equal(curve.at(2), -1);
});

test('PCHIP: independent rational answers for unequal widths and harmonic derivatives', () => {
  // h=(1,2), secants=(1,1/2), derivatives=(7/6,9/13,1/6).
  const curve = makeInterpolator([[0, 0], [1, 1], [3, 2]], 'pchip');
  near(curve.at(0.5), 349 / 624);
  near(curve.at(2), 509 / 312);
  near(curve.crossings(349 / 624).points[0], 0.5);
  near(curve.crossings(509 / 312).points[0], 2);
  // One-sided endpoint slopes, checked independently of interior values.
  near(curve.at(1e-7)! / 1e-7, 7 / 6, 1e-6);
  near((2 - curve.at(3 - 1e-7)!) / 1e-7, 1 / 6, 1e-6);
});

test('PCHIP: analytic quadratic peak and both threshold crossings', () => {
  // On [0,1], p(x)=2x-x^2; on [1,2], p(x)=1-(x-1)^2.
  const curve = makeInterpolator([[0, 0], [1, 1], [2, 0]], 'pchip');
  for (const x of [0.1, 0.3, 0.7, 1, 1.4, 1.9]) near(curve.at(x), 1 - (x - 1) ** 2);
  assert.deepEqual(curve.crossings(0.75), { points: [0.5, 1.5], plateaus: [] });
  near(curve.crossings(0.2).points[0], 1 - Math.sqrt(0.8));
  near(curve.crossings(0.2).points[1], 1 + Math.sqrt(0.8));
});

test('PCHIP: flat segment, zero endpoint slope, and 3-secant endpoint limiter', () => {
  const flat = makeInterpolator([[0, 0], [1, 0], [2, 1]], 'pchip');
  near(flat.at(1.5), 5 / 16); // 1.5*t^2 - 0.5*t^3, t=1/2.
  near(flat.crossings(5 / 16).points[0], 1.5);
  near(makeInterpolator([[0, 0], [1, 1], [2, 10]], 'pchip').at(0.5), 11 / 40);
  near(makeInterpolator([[0, 0], [1, 1], [2, -10]], 'pchip').at(0.5), 7 / 8);
  // Mirror in x to exercise the right endpoint independently.
  near(makeInterpolator([[0, -10], [1, 1], [2, 0]], 'pchip').at(1.5), 7 / 8);
});

test('PCHIP: densely sampled segments never overshoot and preserve local monotonicity', () => {
  const grids: XY[][] = [
    [[-8, -3], [-7.99, -2.9], [0, 0], [0.2, 0.01], [8, 100]],
    [[0, 3], [0.01, -2], [4, 8], [4.01, 8], [9, -3]],
    [[0, 0], [1e-10, 1], [2, 1.00001], [100, 9]],
  ];
  for (const input of grids) for (const sign of [1, -1]) {
    const data = input.map(([x, y]): XY => [x, sign * y]);
    const curve = makeInterpolator(data, 'pchip');
    for (let i = 0; i < data.length - 1; i++) {
      const [x0, y0] = data[i], [x1, y1] = data[i + 1];
      let previous = y0;
      for (let k = 1; k <= 200; k++) {
        const value = curve.at(k === 200 ? x1 : x0 + (x1 - x0) * k / 200)!;
        assert.ok(Number.isFinite(value));
        assert.ok(value >= Math.min(y0, y1) && value <= Math.max(y0, y1));
        assert.ok(y1 >= y0 ? value >= previous : value <= previous);
        previous = value;
      }
    }
  }
});

test('PCHIP: C1 continuity at irregular interior knots', () => {
  const curve = makeInterpolator([[0, 0], [1, 1], [3, 2]], 'pchip');
  const epsilon = 1e-6;
  near((curve.at(1)! - curve.at(1 - epsilon)!) / epsilon, 9 / 13, 1e-6);
  near((curve.at(1 + epsilon)! - curve.at(1)!) / epsilon, 9 / 13, 1e-6);
});

test('pathological scales: sensible range failures rather than nonfinite PCHIP', () => {
  assert.throws(() => makeInterpolator([[0, 0], [Number.MIN_VALUE, 1]], 'pchip'), /secant/);
  assert.throws(() => makeInterpolator([[0, 0], [1e300, 1e-300]], 'pchip'), /underflow/);
  assert.throws(() => makeInterpolator([[0, -Number.MAX_VALUE], [1, Number.MAX_VALUE]], 'pchip'), /difference/);
  const linear = makeInterpolator([[0, -Number.MAX_VALUE], [1, Number.MAX_VALUE]], 'linear');
  assert.equal(linear.at(0.5), 0);
  assert.deepEqual(linear.crossings(0), { points: [0.5], plateaus: [] });
  const subnormal = makeInterpolator([[0, 0], [Number.MIN_VALUE, Number.MIN_VALUE]], 'pchip');
  assert.equal(subnormal.at(Number.MIN_VALUE), Number.MIN_VALUE);
  const wide = makeInterpolator([[0, 0], [1e308, 1], [1.7e308, 2]], 'pchip');
  assert.ok(Number.isFinite(wide.at(5e307)));
  const nearZeroRoot = makeInterpolator([[0, 0], [1, 1]], 'pchip').crossings(1e-200).points[0];
  assert.ok(Math.abs(nearZeroRoot / 1e-200 - 1) < 1e-14);
});

test('invalid interpolation kind is rejected even on empty input', () => {
  assert.throws(() => makeInterpolator([], 'spline' as Interpolation), RangeError);
});

test('affine PCHIP honors subnormal queries and threshold roots exactly', () => {
  for (const data of [[[0, 0], [1, 1]], [[0, 0], [1, 1], [2, 2]]] as XY[][]) {
    const curve = makeInterpolator(data, 'pchip');
    assert.equal(curve.at(Number.MIN_VALUE), Number.MIN_VALUE);
    assert.equal(curve.crossings(Number.MIN_VALUE).points[0], Number.MIN_VALUE);
  }
});

test('EMA nonfinite inputs and unrepresentable endpoint derivatives fail explicitly', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => ema([[value, 1]], 0.5), RangeError);
    assert.throws(() => ema([[0, value]], 0.5), RangeError);
  }
  assert.throws(() => makeInterpolator([[0, 0], [0.5, 8e307], [1, 0]], 'pchip'), /endpoint derivative/);
});

test('unrepresentable normalized interior coordinates fail rather than returning an endpoint', () => {
  for (const kind of kinds) {
    const curve = makeInterpolator([[0, 0], [1e300, 1e300]], kind);
    assert.throws(() => curve.at(Number.MIN_VALUE), /query underflow/);
    assert.throws(() => curve.crossings(Number.MIN_VALUE), /threshold underflow/);
    assert.equal(makeInterpolator([[0, 2], [1e300, 2]], kind).at(Number.MIN_VALUE), 2);
  }
});

test('relative coordinates use each run creation time, not its first logged point', () => {
  const startA = 1_700_000_000_000, startB = startA + 86_400_000;
  const a = [point(1, 70, startA + 5000, 2), point(2, 90, startA + 7000, 6)];
  const b = [point(1, 0, startB + 5000, 2), point(2, 1, startB + 7000, 6)];
  const before = structuredClone(a);
  assert.deepEqual(canonicalize(a, 'relative', startA), [[5000, 2], [7000, 6]]);
  assert.deepEqual(canonicalize(a, 'relative', startA), canonicalize(b, 'relative', startB));
  for (const kind of kinds) {
    const curve = makeInterpolator(canonicalize(a, 'relative', startA), kind);
    assert.equal(curve.at(0), null); // no extrapolation across late logging
    assert.equal(curve.at(5500), 3);
    assert.deepEqual(curve.crossings(3), { points: [5500], plateaus: [] });
  }
  assert.deepEqual(a, before);
});

test('relative canonicalization sorts elapsed values and retains seq/tie semantics', () => {
  const data = [point(8, 0, 110, 8), point(9, 1, 90, 9), point(7, 2, 110, 7),
    point(8, 3, 110, 18), point(1, 4, 100, 1)];
  assert.deepEqual(canonicalize(data, 'relative', 100), [[-10, 9], [0, 1], [10, 18]]);
  assert.deepEqual(canonicalize([point(1, 0, 0.125, 1)], 'relative', 0), [[0.125, 1]]);
  assert.deepEqual(canonicalize([], 'relative', 0), []);
});

test('relative origin is mandatory and finite even for empty data; subtraction must be finite', () => {
  for (const origin of [undefined, NaN, Infinity, -Infinity]) {
    assert.throws(() => canonicalize([], 'relative', origin), /runStart must be finite/);
    assert.throws(() => canonicalize([point(1, 0, 10, 2)], 'relative', origin), /runStart/);
    // Origins are irrelevant for the original axes; their behavior is unchanged.
    assert.deepEqual(canonicalize([point(1, 0, 10, 2)], 'step', origin), [[0, 2]]);
    assert.deepEqual(canonicalize([point(1, 0, 10, 2)], 'timestamp', origin), [[10, 2]]);
  }
  assert.throws(() => canonicalize([point(1, 0, Number.MAX_VALUE, 2)], 'relative', -Number.MAX_VALUE), /Relative timestamp/);
  for (const field of ['seq', 'step', 'timestamp', 'value'] as const) {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      const discarded = { ...point(1, 0, 10, 1), [field]: invalid };
      assert.throws(() => canonicalize([point(2, 0, 10, 2), discarded], 'relative', 5), RangeError);
    }
  }
});

test('relative irregular-grid PCHIP keeps independently known interpolation and roots', () => {
  const start = 1_700_000_000_000;
  const data = [point(1, 0, start + 5000, 0), point(2, 1, start + 6000, 1), point(3, 2, start + 8000, 2)];
  const curve = makeInterpolator(canonicalize(data, 'relative', start), 'pchip');
  near(curve.at(5500), 349 / 624);
  near(curve.at(7000), 509 / 312);
  near(curve.crossings(509 / 312).points[0], 7000);
});
