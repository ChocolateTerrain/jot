import type { NormalizedPoint } from './stroke-math';

/** Strokes within this many degrees of horizontal snap perfectly flat. */
export const HORIZONTAL_SNAP_DEG = 8;

/**
 * Replace a freehand stroke with a straight segment from its first to last
 * point. Works in pixel space (via width/height) so the snap angle is accurate
 * on non-square pages, then converts back to normalized coordinates.
 */
export function straightenPoints(
	points: NormalizedPoint[],
	width: number,
	height: number,
): NormalizedPoint[] {
	const first = points[0];
	const last = points[points.length - 1];
	if (!first || !last || points.length < 2 || width <= 0 || height <= 0) return points;

	const pressure = points.reduce((total, p) => total + p.pressure, 0) / points.length;
	const dx = (last.x - first.x) * width;
	const dy = (last.y - first.y) * height;
	const angle = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
	const nearHorizontal = angle <= HORIZONTAL_SNAP_DEG || angle >= 180 - HORIZONTAL_SNAP_DEG;

	if (nearHorizontal) {
		// Keep the line at the average height of the stroke so it stays on the text.
		const y = points.reduce((total, p) => total + p.y, 0) / points.length;
		return [
			{ x: first.x, y, pressure },
			{ x: last.x, y, pressure },
		];
	}
	return [
		{ x: first.x, y: first.y, pressure },
		{ x: last.x, y: last.y, pressure },
	];
}
