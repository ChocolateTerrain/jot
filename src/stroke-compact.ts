import type { NormalizedPoint } from './stroke-math';

// Stored precision. 1e-5 of the page is ~0.01 px on a 1000 px page, far below
// anything visible; pressure only feeds an average, so 3 decimals is plenty.
const COORD_SCALE = 1e5;
const PRESSURE_SCALE = 1e3;

/** Pencil samples closer than this (in screen pixels) add nothing visible. */
export const MIN_POINT_SPACING_PX = 0.75;

export function roundPoint(point: NormalizedPoint): NormalizedPoint {
	return {
		x: Math.round(point.x * COORD_SCALE) / COORD_SCALE,
		y: Math.round(point.y * COORD_SCALE) / COORD_SCALE,
		pressure: Math.round(point.pressure * PRESSURE_SCALE) / PRESSURE_SCALE,
	};
}

/**
 * Shrink a freshly drawn stroke before it is stored: drop samples that sit
 * within MIN_POINT_SPACING_PX of the previous kept one (always keeping the
 * first and last) and round the rest. A large PDF's annotation file gets
 * several times smaller, so saving after each stroke is much cheaper.
 */
export function compactPoints(
	points: NormalizedPoint[],
	widthPx: number,
	heightPx: number,
): NormalizedPoint[] {
	if (points.length <= 2 || widthPx <= 0 || heightPx <= 0) return points.map(roundPoint);
	const minSq = MIN_POINT_SPACING_PX * MIN_POINT_SPACING_PX;
	const kept: NormalizedPoint[] = [points[0]!];
	let last = points[0]!;
	for (let i = 1; i < points.length - 1; i++) {
		const p = points[i]!;
		const dx = (p.x - last.x) * widthPx;
		const dy = (p.y - last.y) * heightPx;
		if (dx * dx + dy * dy >= minSq) {
			kept.push(p);
			last = p;
		}
	}
	kept.push(points[points.length - 1]!);
	return kept.map(roundPoint);
}
