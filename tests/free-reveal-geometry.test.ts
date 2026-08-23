import assert from "node:assert/strict";
import test from "node:test";
import {
  createRevealRectFromPoints,
  getRevealRectUnionArea,
  moveRevealRect,
  normalizePersonalRevealState,
  normalizeRevealRect,
  resizeRevealRect,
  revealRectsAddVisibleArea,
  revealRectsCoverImage,
} from "../src/lib/freeRevealGeometry";

test("normalizes drag direction and rejects invalid rectangles", () => {
  assert.deepEqual(createRevealRectFromPoints(0.8, 0.7, 0.2, 0.1), { x: 0.2, y: 0.1, width: 0.6, height: 0.6 });
  assert.deepEqual(normalizeRevealRect({ x: -0.00001, y: 0, width: 0.5, height: 1 }), { x: 0, y: 0, width: 0.5, height: 1 });
  assert.equal(normalizeRevealRect({ x: 0, y: 0, width: 0, height: 1 }), null);
  assert.equal(normalizeRevealRect({ x: 0.8, y: 0, width: 0.3, height: 1 }), null);
  assert.equal(normalizeRevealRect({ x: Number.NaN, y: 0, width: 1, height: 1 }), null);
});

test("moves and resizes rectangles within image bounds", () => {
  assert.deepEqual(moveRevealRect({ x: 0.2, y: 0.2, width: 0.4, height: 0.4 }, 0.8, -0.4), {
    x: 0.6,
    y: 0,
    width: 0.4,
    height: 0.4,
  });
  assert.deepEqual(resizeRevealRect({ x: 0.2, y: 0.2, width: 0.4, height: 0.4 }, "nw", -0.3, -0.3, 0.01, 0.01), {
    x: 0,
    y: 0,
    width: 0.6,
    height: 0.6,
  });
  assert.deepEqual(resizeRevealRect({ x: 0.2, y: 0.2, width: 0.4, height: 0.4 }, "se", 0.8, 0.8, 0.01, 0.01), {
    x: 0.2,
    y: 0.2,
    width: 0.8,
    height: 0.8,
  });
});

test("computes overlapping union area and detects new visible area", () => {
  const left = { x: 0, y: 0, width: 0.6, height: 1 };
  const right = { x: 0.4, y: 0, width: 0.6, height: 1 };
  assert.equal(getRevealRectUnionArea([left, right]), 1);
  assert.equal(revealRectsAddVisibleArea([left], [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }]), false);
  assert.equal(revealRectsAddVisibleArea([left], [right]), true);
  assert.equal(revealRectsCoverImage([left, right]), true);
});

test("detects complete coverage from multiple adjacent rectangles", () => {
  assert.equal(revealRectsCoverImage([
    { x: 0, y: 0, width: 0.5, height: 0.5 },
    { x: 0.5, y: 0, width: 0.5, height: 0.5 },
    { x: 0, y: 0.5, width: 0.5, height: 0.5 },
    { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  ]), true);
});

test("maximum per-question rectangle state remains within the snapshot payload budget", () => {
  const state = normalizePersonalRevealState({
    version: 1,
    mode: "FREE_RECT",
    fullyRevealed: false,
    regions: Array.from({ length: 160 }, (_, index) => ({
      id: `host:${index}:confirmRevealRegions:${index % 16}`,
      x: (index % 10) / 10,
      y: Math.floor(index / 10) % 10 / 10,
      width: 0.05,
      height: 0.05,
    })),
  });
  assert.equal(state.regions.length, 160);
  assert.ok(new TextEncoder().encode(JSON.stringify(state)).byteLength < 32 * 1024);
});
