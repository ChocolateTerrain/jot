import type { NormalizedPoint } from './stroke-math';

/** Strokes within this many degrees of horizontal snap perfectly flat. */
export const HORIZONTAL_SNAP_DEG = 8;

/**
 * A stroke only counts as "a wobbly line" if no point strays further from the
 * start→end line than this fraction of its length. Circles, arcs, V shapes
 * and scribbles exceed it and are left as drawn.
 */
export const MAX_WOBBLE_RATIO = 0.12;

/** Strokes shorter than this (in pixels) are left alone: too short to judge. */
export const MIN_STRAIGHTEN_LENGTH_PX = 12;

/**
 * A wobbly line travels only a little further than the straight distance; a
 * zigzag (e.g. scribbling over a block of text) travels much further.
 */
export const MAX_PATH_RATIO = 1.3;

/** Ignore hand jitter smaller than this when measuring the path length. */
const PATH_STEP_PX = 4;

/** True when the stroke is roughly a line (wobbles allowed), in pixel space. */
export function isNearlyStraight(points: NormalizedPoint[], width: number, height: number): boolean {
	const first = points[0];
	const last = points[points.length - 1];
	if (!first || !last || points.length < 2) return false;
	const dx = (last.x - first.x) * width;
	const dy = (last.y - first.y) * height;
	const length = Math.hypot(dx, dy);
	if (length < MIN_STRAIGHTEN_LENGTH_PX) return false;
	let maxDeviation = 0;
	for (const p of points) {
		const px = (p.x - first.x) * width;
		const py = (p.y - first.y) * height;
		// Distance to the infinite start→end line…
		let deviation = Math.abs(px * dy - py * dx) / length;
		// …or, beyond either end, to that endpoint (catches doubling back).
		const along = (px * dx + py * dy) / length;
		if (along < 0) deviation = Math.hypot(px, py);
		else if (along > length) deviation = Math.hypot(px - dx, py - dy);
		maxDeviation = Math.max(maxDeviation, deviation);
	}
	if (maxDeviation > MAX_WOBBLE_RATIO * length) return false;
	return pathLength(points, width, height) <= MAX_PATH_RATIO * length;
}

/** Path length in pixels, skipping jitter below PATH_STEP_PX. */
function pathLength(points: NormalizedPoint[], width: number, height: number): number {
	let total = 0;
	let anchor = points[0]!;
	for (const p of points) {
		const step = Math.hypot((p.x - anchor.x) * width, (p.y - anchor.y) * height);
		if (step >= PATH_STEP_PX) {
			total += step;
			anchor = p;
		}
	}
	const last = points[points.length - 1]!;
	return total + Math.hypot((last.x - anchor.x) * width, (last.y - anchor.y) * height);
}

/**
 * Best-fit line through all points (principal axis, in pixels), returned as
 * its two extreme points ordered first→last. Fitting all points means a small
 * flick at either end barely tilts or stretches the result.
 */
function fitLine(points: NormalizedPoint[], width: number, height: number): [Px, Px] {
	const px = points.map((p) => ({ x: p.x * width, y: p.y * height }));
	const n = px.length;
	const cx = px.reduce((t, p) => t + p.x, 0) / n;
	const cy = px.reduce((t, p) => t + p.y, 0) / n;
	let sxx = 0;
	let syy = 0;
	let sxy = 0;
	for (const p of px) {
		sxx += (p.x - cx) ** 2;
		syy += (p.y - cy) ** 2;
		sxy += (p.x - cx) * (p.y - cy);
	}
	const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
	let ux = Math.cos(theta);
	let uy = Math.sin(theta);
	// Orient along the drawing direction.
	const first = px[0]!;
	const last = px[n - 1]!;
	if ((last.x - first.x) * ux + (last.y - first.y) * uy < 0) {
		ux = -ux;
		uy = -uy;
	}
	let tMin = Infinity;
	let tMax = -Infinity;
	for (const p of px) {
		const t = (p.x - cx) * ux + (p.y - cy) * uy;
		tMin = Math.min(tMin, t);
		tMax = Math.max(tMax, t);
	}
	return [
		{ x: cx + ux * tMin, y: cy + uy * tMin },
		{ x: cx + ux * tMax, y: cy + uy * tMax },
	];
}

interface Px {
	x: number;
	y: number;
}

/**
 * If the stroke is a roughly straight line, replace it with a straight
 * segment from its first to last point; otherwise return it unchanged. Works in pixel space (via width/height) so the snap angle is accurate
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
	if (!isNearlyStraight(points, width, height)) return points;

	const pressure = points.reduce((total, p) => total + p.pressure, 0) / points.length;
	const [a, b] = fitLine(points, width, height);
	const angle = Math.abs((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
	const nearHorizontal = angle <= HORIZONTAL_SNAP_DEG || angle >= 180 - HORIZONTAL_SNAP_DEG;

	if (nearHorizontal) {
		// Level, spanning the stroke's full width, at its average height so it
		// stays on the text.
		const y = points.reduce((total, p) => total + p.y, 0) / points.length;
		const xs = points.map((p) => p.x);
		const minX = Math.min(...xs);
		const maxX = Math.max(...xs);
		const leftToRight = last.x >= first.x;
		return [
			{ x: leftToRight ? minX : maxX, y, pressure },
			{ x: leftToRight ? maxX : minX, y, pressure },
		];
	}
	return [
		{ x: a.x / width, y: a.y / height, pressure },
		{ x: b.x / width, y: b.y / height, pressure },
	];
}
