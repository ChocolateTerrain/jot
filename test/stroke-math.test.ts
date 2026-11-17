import { describe, expect, it } from 'vitest';
import type { NormalizedPoint } from '../src/stroke-math';
import {
	PRESSURE_MAX_FACTOR,
	PRESSURE_MIN_FACTOR,
	forEachSmoothSegment,
	midpoint,
	subdivideQuadratic,
	widthFactorForPressure,
} from '../src/stroke-math';

const point = (x: number, y: number, pressure = 0.5): NormalizedPoint => ({ x, y, pressure });

const collectPairs = (
	run: (emit: (a: NormalizedPoint, b: NormalizedPoint) => void) => void,
): Array<[NormalizedPoint, NormalizedPoint]> => {
	const pairs: Array<[NormalizedPoint, NormalizedPoint]> = [];
	run((a, b) => pairs.push([a, b]));
	return pairs;
};

describe('widthFactorForPressure', () => {
	it('returns the minimum factor at zero pressure', () => {
		expect(widthFactorForPressure(0)).toBe(PRESSURE_MIN_FACTOR);
	});
	it('returns the maximum factor at full pressure', () => {
		expect(widthFactorForPressure(1)).toBe(PRESSURE_MAX_FACTOR);
	});
	it('interpolates linearly between min and max at half pressure', () => {
		const expected = (PRESSURE_MIN_FACTOR + PRESSURE_MAX_FACTOR) / 2;
		expect(widthFactorForPressure(0.5)).toBeCloseTo(expected);
	});
	it('clamps pressures below zero to the minimum factor', () => {
		expect(widthFactorForPressure(-1)).toBe(PRESSURE_MIN_FACTOR);
	});
	it('clamps pressures above one to the maximum factor', () => {
		expect(widthFactorForPressure(2)).toBe(PRESSURE_MAX_FACTOR);
	});
});

describe('midpoint', () => {
	it('averages x, y, and pressure of the two points', () => {
		expect(midpoint(point(0, 0, 0), point(10, 20, 1))).toEqual({ x: 5, y: 10, pressure: 0.5 });
	});
});

describe('subdivideQuadratic', () => {
	it('emits exactly the requested number of segments', () => {
		const pairs = collectPairs((emit) =>
			subdivideQuadratic(point(0, 0), point(0.5, 1), point(1, 0), 4, emit),
		);
		expect(pairs).toHaveLength(4);
	});
	it('ends at the curve endpoint', () => {
		const pairs = collectPairs((emit) =>
			subdivideQuadratic(point(0, 0), point(0.5, 1), point(1, 0), 4, emit),
		);
		const lastEnd = pairs[pairs.length - 1]![1];
		expect(lastEnd.x).toBeCloseTo(1);
		expect(lastEnd.y).toBeCloseTo(0);
	});
	it('connects each segment end to the next segment start', () => {
		const pairs = collectPairs((emit) =>
			subdivideQuadratic(point(0, 0), point(0.5, 1), point(1, 0), 4, emit),
		);
		for (let i = 1; i < pairs.length; i++) {
			expect(pairs[i]![0]).toEqual(pairs[i - 1]![1]);
		}
	});
	it('interpolates pressure linearly between endpoints and ignores the control pressure', () => {
		const points: NormalizedPoint[] = [];
		subdivideQuadratic(
			point(0, 0, 0),
			point(0, 0, 999),
			point(1, 0, 1),
			4,
			(_, b) => points.push(b),
		);
		expect(points[0]!.pressure).toBeCloseTo(0.25);
		expect(points[points.length - 1]!.pressure).toBeCloseTo(1);
	});
});

describe('forEachSmoothSegment', () => {
	it('emits nothing for an empty point list', () => {
		const pairs = collectPairs((emit) => forEachSmoothSegment([], emit));
		expect(pairs).toEqual([]);
	});
	it('emits nothing for a single point', () => {
		const pairs = collectPairs((emit) => forEachSmoothSegment([point(0, 0)], emit));
		expect(pairs).toEqual([]);
	});
	it('emits a single straight segment for exactly two points', () => {
		const pairs = collectPairs((emit) =>
			forEachSmoothSegment([point(0, 0), point(1, 1)], emit),
		);
		expect(pairs).toEqual([[point(0, 0), point(1, 1)]]);
	});
	it('starts the emitted run at the first recorded point', () => {
		const pairs = collectPairs((emit) =>
			forEachSmoothSegment([point(0.1, 0.2), point(0.3, 0.4), point(0.5, 0.6)], emit),
		);
		expect(pairs[0]![0]).toEqual(point(0.1, 0.2));
	});
	it('ends the emitted run at the last recorded point', () => {
		const pairs = collectPairs((emit) =>
			forEachSmoothSegment([point(0.1, 0.2), point(0.3, 0.4), point(0.5, 0.6)], emit),
		);
		expect(pairs[pairs.length - 1]![1]).toEqual(point(0.5, 0.6));
	});
	it('produces a continuous chain where each segment starts where the previous ended', () => {
		const pairs = collectPairs((emit) =>
			forEachSmoothSegment(
				[point(0, 0), point(0.5, 1), point(1, 0), point(1.5, -1)],
				emit,
			),
		);
		for (let i = 1; i < pairs.length; i++) {
			expect(pairs[i]![0]).toEqual(pairs[i - 1]![1]);
		}
	});
});
