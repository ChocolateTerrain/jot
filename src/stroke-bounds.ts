import type { NormalizedPoint } from './stroke-math';

/** Axis-aligned box in normalized page coordinates. */
export interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

// Stroke point arrays are never mutated after a stroke is saved (erasing makes
// new arrays), so their bounds can be cached by identity.
const cache = new WeakMap<NormalizedPoint[], Bounds>();

export function boundsOf(points: NormalizedPoint[]): Bounds {
	let bounds = cache.get(points);
	if (bounds) return bounds;
	bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
	for (const p of points) {
		if (p.x < bounds.minX) bounds.minX = p.x;
		if (p.y < bounds.minY) bounds.minY = p.y;
		if (p.x > bounds.maxX) bounds.maxX = p.x;
		if (p.y > bounds.maxY) bounds.maxY = p.y;
	}
	cache.set(points, bounds);
	return bounds;
}

/** Bounds grown by a margin given separately for x and y. */
export function grow(b: Bounds, mx: number, my: number): Bounds {
	return { minX: b.minX - mx, minY: b.minY - my, maxX: b.maxX + mx, maxY: b.maxY + my };
}

export function intersects(a: Bounds, b: Bounds): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function union(a: Bounds | null, b: Bounds): Bounds {
	if (!a) return b;
	return {
		minX: Math.min(a.minX, b.minX),
		minY: Math.min(a.minY, b.minY),
		maxX: Math.max(a.maxX, b.maxX),
		maxY: Math.max(a.maxY, b.maxY),
	};
}
