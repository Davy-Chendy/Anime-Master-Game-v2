import type { PersonalRevealMode, PersonalRevealState, RevealRect, RevealRegion } from "../types/game";

export const REVEAL_COORDINATE_PRECISION = 10_000;
const GEOMETRY_EPSILON = 1 / REVEAL_COORDINATE_PRECISION;

export type RevealResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

function quantize(value: number) {
  return Math.round(value * REVEAL_COORDINATE_PRECISION) / REVEAL_COORDINATE_PRECISION;
}

export function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function normalizeRevealRect(value: unknown): RevealRect | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<Record<keyof RevealRect, unknown>>;
  const values = [record.x, record.y, record.width, record.height];
  if (!values.every((item) => typeof item === "number" && Number.isFinite(item))) return null;

  const rawX = record.x as number;
  const rawY = record.y as number;
  const rawWidth = record.width as number;
  const rawHeight = record.height as number;
  if (rawWidth <= 0 || rawHeight <= 0) return null;
  if (rawX < -GEOMETRY_EPSILON || rawY < -GEOMETRY_EPSILON) return null;
  if (rawX + rawWidth > 1 + GEOMETRY_EPSILON || rawY + rawHeight > 1 + GEOMETRY_EPSILON) return null;

  const x = quantize(clampUnit(rawX));
  const y = quantize(clampUnit(rawY));
  const width = quantize(Math.min(1 - x, rawWidth));
  const height = quantize(Math.min(1 - y, rawHeight));
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function normalizePersonalRevealMode(value: unknown): PersonalRevealMode {
  return value === "FREE_RECT" ? "FREE_RECT" : "GRID";
}

export function createPersonalRevealState(mode: PersonalRevealMode): PersonalRevealState {
  return { version: 1, mode, regions: [], fullyRevealed: false };
}

export function normalizePersonalRevealState(value: unknown, fallbackMode: PersonalRevealMode = "GRID"): PersonalRevealState {
  if (!value || typeof value !== "object") return createPersonalRevealState(fallbackMode);
  const record = value as { mode?: unknown; regions?: unknown; fullyRevealed?: unknown };
  const mode = normalizePersonalRevealMode(record.mode ?? fallbackMode);
  const regions = Array.isArray(record.regions)
    ? record.regions.flatMap((candidate, index) => {
        const rect = normalizeRevealRect(candidate);
        const id = candidate && typeof candidate === "object" && typeof (candidate as { id?: unknown }).id === "string"
          ? (candidate as { id: string }).id.slice(0, 160)
          : `restored:${index}`;
        return rect ? [{ id, ...rect } satisfies RevealRegion] : [];
      }).slice(0, 160)
    : [];
  return {
    version: 1,
    mode,
    regions,
    fullyRevealed: record.fullyRevealed === true,
  };
}

export function createRevealRectFromPoints(startX: number, startY: number, endX: number, endY: number) {
  return normalizeRevealRect({
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  });
}

export function moveRevealRect(rect: RevealRect, deltaX: number, deltaY: number): RevealRect {
  return {
    ...rect,
    x: quantize(Math.min(1 - rect.width, Math.max(0, rect.x + deltaX))),
    y: quantize(Math.min(1 - rect.height, Math.max(0, rect.y + deltaY))),
  };
}

export function resizeRevealRect(rect: RevealRect, handle: RevealResizeHandle, deltaX: number, deltaY: number, minWidth: number, minHeight: number): RevealRect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle.includes("w")) left = Math.min(right - minWidth, Math.max(0, left + deltaX));
  if (handle.includes("e")) right = Math.max(left + minWidth, Math.min(1, right + deltaX));
  if (handle.includes("n")) top = Math.min(bottom - minHeight, Math.max(0, top + deltaY));
  if (handle.includes("s")) bottom = Math.max(top + minHeight, Math.min(1, bottom + deltaY));
  return {
    x: quantize(left),
    y: quantize(top),
    width: quantize(right - left),
    height: quantize(bottom - top),
  };
}

export function getRevealRectUnionArea(rects: readonly RevealRect[]) {
  if (rects.length === 0) return 0;
  const edges = Array.from(new Set(rects.flatMap((rect) => [rect.x, rect.x + rect.width]))).sort((a, b) => a - b);
  let area = 0;
  for (let index = 0; index < edges.length - 1; index += 1) {
    const left = edges[index];
    const right = edges[index + 1];
    if (right - left <= GEOMETRY_EPSILON / 10) continue;
    const intervals = rects
      .filter((rect) => rect.x < right && rect.x + rect.width > left)
      .map((rect) => [rect.y, rect.y + rect.height] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (intervals.length === 0) continue;
    let coveredY = 0;
    let start = intervals[0][0];
    let end = intervals[0][1];
    for (let intervalIndex = 1; intervalIndex < intervals.length; intervalIndex += 1) {
      const interval = intervals[intervalIndex];
      if (interval[0] <= end) end = Math.max(end, interval[1]);
      else {
        coveredY += end - start;
        start = interval[0];
        end = interval[1];
      }
    }
    coveredY += end - start;
    area += (right - left) * coveredY;
  }
  return area;
}

export function revealRectsAddVisibleArea(existing: readonly RevealRect[], additions: readonly RevealRect[]) {
  const previousArea = getRevealRectUnionArea(existing);
  const nextArea = getRevealRectUnionArea([...existing, ...additions]);
  return nextArea - previousArea > GEOMETRY_EPSILON * GEOMETRY_EPSILON;
}

export function revealRectsCoverImage(rects: readonly RevealRect[]) {
  return getRevealRectUnionArea(rects) >= 1 - GEOMETRY_EPSILON * GEOMETRY_EPSILON;
}
