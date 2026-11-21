import type { NormalizedPoint, Stroke } from './stroke-math';
import { widthFactorForPressure } from './stroke-math';
import { HIGHLIGHTER_WIDTH_FACTOR } from './stroke-render';
import { roundPoint } from './stroke-compact';
import { Bounds, boundsOf, grow, intersects } from './stroke-bounds';

export interface PageSize {
	width: number;
	height: number;
}

/** Eraser radius as a fraction of page height, from the selected width button. */
export function eraserRadiusFor(width: number): number {
	return 0.006 + 3.2 * width;
}

/** Half the drawn line thickness of a stroke, in pixels. */
function halfThicknessPx(stroke: Stroke, page: PageSize): number {
	if (stroke.tool === 'highlighter') {
		return (stroke.width * HIGHLIGHTER_WIDTH_FACTOR * page.height) / 2;
	}
	const avg = averagePressure(stroke.points);
	return (stroke.width * widthFactorForPressure(avg) * page.height) / 2;
}

const pressureCache = new WeakMap<NormalizedPoint[], number>();

/** Average pressure, cached per (never mutated) point array. */
function averagePressure(points: NormalizedPoint[]): number {
	if (points.length === 0) return 0.5;
	let avg = pressureCache.get(points);
	if (avg === undefined) {
		avg = points.reduce((total, p) => total + p.pressure, 0) / points.length;
		pressureCache.set(points, avg);
	}
	return avg;
}

interface Px {
	x: number;
	y: number;
}

/**
 * Erase a circle (center in normalized coordinates, radius in pixels) from
 * the stroke. Returns null when the stroke is untouched (so callers can keep
 * the same object and its render cache), otherwise the remaining pieces
 * (possibly none).
 *
 * The centerline is cut where it enters the circle grown by half the line
 * thickness, so the round caps of what remains end at the circle's edge and
 * the visible gap matches the eraser cursor.
 */
export function eraseCircleFromStroke(
	stroke: Stroke,
	cx: number,
	cy: number,
	radiusPx: number,
	page: PageSize,
): Stroke[] | null {
	const points = stroke.points;
	if (points.length === 0) return null;
	const c: Px = { x: cx * page.width, y: cy * page.height };
	const r = radiusPx + halfThicknessPx(stroke, page);
	const r2 = r * r;
	const px = points.map((p) => ({ x: p.x * page.width, y: p.y * page.height }));

	// Quick reject: nothing within reach of the circle.
	let hit = false;
	if (px.length === 1) {
		hit = dist2(px[0]!, c) < r2;
	} else {
		for (let i = 0; i < px.length - 1 && !hit; i++) {
			hit = segmentDist2(px[i]!, px[i + 1]!, c) < r2;
		}
	}
	if (!hit) return null;

	// Pieces keep the original average pressure so pen thickness doesn't change.
	const pressure = averagePressure(points);
	const toNorm = (p: Px): NormalizedPoint =>
		roundPoint({ x: p.x / page.width, y: p.y / page.height, pressure });

	const pieces: NormalizedPoint[][] = [];
	let current: NormalizedPoint[] = [];
	const flush = () => {
		if (current.length >= 2) pieces.push(current);
		current = [];
	};

	for (let i = 0; i < px.length; i++) {
		const p = px[i]!;
		const inside = dist2(p, c) < r2;
		if (i === 0) {
			if (!inside) current.push(toNorm(p));
			continue;
		}
		const a = px[i - 1]!;
		// Where (as fractions along a→p) the segment crosses the circle.
		const [t0, t1] = circleCrossings(a, p, c, r);
		const prevInside = dist2(a, c) < r2;
		if (!prevInside && !inside) {
			if (t0 !== null && t1 !== null && t0 > 0 && t1 < 1) {
				// Segment passes straight through the circle: cut a gap in it.
				current.push(toNorm(lerp(a, p, t0)));
				flush();
				current.push(toNorm(lerp(a, p, t1)));
			}
			current.push(toNorm(p));
		} else if (!prevInside && inside) {
			if (t0 !== null) current.push(toNorm(lerp(a, p, clamp01(t0))));
			flush();
		} else if (prevInside && !inside) {
			if (t1 !== null) current.push(toNorm(lerp(a, p, clamp01(t1))));
			current.push(toNorm(p));
		}
		// Both inside: the segment is erased entirely.
	}
	flush();

	return pieces.map((piece) => ({ ...stroke, points: piece }));
}

function clamp01(t: number): number {
	return Math.max(0, Math.min(1, t));
}

function lerp(a: Px, b: Px, t: number): Px {
	return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function dist2(a: Px, b: Px): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

function segmentDist2(a: Px, b: Px, c: Px): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : clamp01(((c.x - a.x) * dx + (c.y - a.y) * dy) / len2);
	return dist2(lerp(a, b, t), c);
}

/** Parameters t (along a→b, unclamped) where the line meets the circle, entry first. */
function circleCrossings(a: Px, b: Px, c: Px, r: number): [number | null, number | null] {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const fx = a.x - c.x;
	const fy = a.y - c.y;
	const qa = dx * dx + dy * dy;
	if (qa === 0) return [null, null];
	const qb = 2 * (fx * dx + fy * dy);
	const qc = fx * fx + fy * fy - r * r;
	const disc = qb * qb - 4 * qa * qc;
	if (disc < 0) return [null, null];
	const root = Math.sqrt(disc);
	return [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)];
}

export interface EraseResult {
	strokes: Stroke[];
	/** Area (normalized) whose pixels may have changed, for a partial redraw. */
	dirty: Bounds;
}

/**
 * Erase along the eraser's path from `from` to `to`, sampling often enough
 * that a fast swipe doesn't skip over lines. Returns the new stroke list and
 * the area that changed, or null if nothing changed.
 *
 * Strokes whose bounding box is nowhere near the path are passed through
 * without any per-point work; on a page full of handwriting that is most of
 * them.
 */
export function eraseAlongPath(
	strokes: Stroke[],
	from: { x: number; y: number } | null,
	to: { x: number; y: number },
	radiusPx: number,
	page: PageSize,
): EraseResult | null {
	const samples: { x: number; y: number }[] = [];
	if (from) {
		const dx = (to.x - from.x) * page.width;
		const dy = (to.y - from.y) * page.height;
		const steps = Math.min(50, Math.ceil(Math.hypot(dx, dy) / Math.max(1, radiusPx / 2)));
		for (let i = 1; i < steps; i++) {
			samples.push({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
		}
	}
	samples.push(to);

	const start = from ?? to;
	const rx = radiusPx / page.width;
	const ry = radiusPx / page.height;
	const path: Bounds = grow(
		{
			minX: Math.min(start.x, to.x),
			minY: Math.min(start.y, to.y),
			maxX: Math.max(start.x, to.x),
			maxY: Math.max(start.y, to.y),
		},
		rx,
		ry,
	);

	let changed = false;
	let maxHalf = 0;
	const next: Stroke[] = [];
	for (const stroke of strokes) {
		const half = halfThicknessPx(stroke, page);
		if (!intersects(grow(boundsOf(stroke.points), half / page.width, half / page.height), path)) {
			next.push(stroke);
			continue;
		}
		// Near the path: run every sample over this stroke and its pieces.
		let pieces: Stroke[] = [stroke];
		let touched = false;
		for (const s of samples) {
			const after: Stroke[] = [];
			for (const piece of pieces) {
				const result = eraseCircleFromStroke(piece, s.x, s.y, radiusPx, page);
				if (result === null) {
					after.push(piece);
				} else {
					touched = true;
					after.push(...result);
				}
			}
			pieces = after;
		}
		if (touched) {
			changed = true;
			maxHalf = Math.max(maxHalf, half);
		}
		next.push(...pieces);
	}
	if (!changed) return null;
	// Margin for line thickness, plus the curve smoothing of a cut piece, which
	// can shift its line slightly up to one point-spacing beyond the cut.
	const pad = maxHalf + 16;
	return { strokes: next, dirty: grow(path, pad / page.width, pad / page.height) };
}
