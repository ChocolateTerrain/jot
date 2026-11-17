/* eslint-disable obsidianmd/prefer-active-doc */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	PointerEventHandler,
	type PointerEventHandlerDeps,
} from '../src/pointer-event-handler';
import { StrokeStore } from '../src/stroke-store';
import { straightenPoints } from '../src/stroke-straighten';
import type { NormalizedPoint } from '../src/stroke-math';

const p = (x: number, y: number, pressure = 0.5): NormalizedPoint => ({ x, y, pressure });

describe('straightenPoints', () => {
	it('snaps a wobbly near-horizontal stroke level at its average height', () => {
		const result = straightenPoints(
			[p(0.1, 0.5), p(0.2, 0.52), p(0.3, 0.49), p(0.4, 0.51), p(0.5, 0.5)],
			1000,
			1000,
		);
		expect(result).toHaveLength(2);
		expect(result[0]!.x).toBeCloseTo(0.1);
		expect(result[1]!.x).toBeCloseTo(0.5);
		expect(result[0]!.y).toBeCloseTo(0.504);
		expect(result[1]!.y).toBe(result[0]!.y);
	});

	it('snaps right-to-left strokes too', () => {
		const result = straightenPoints([p(0.5, 0.5), p(0.3, 0.52), p(0.1, 0.51)], 1000, 1000);
		expect(result[0]!.y).toBe(result[1]!.y);
		expect(result[0]!.x).toBeCloseTo(0.5);
		expect(result[1]!.x).toBeCloseTo(0.1);
	});

	it('keeps a diagonal stroke diagonal, joining first and last point', () => {
		const result = straightenPoints([p(0.1, 0.1), p(0.25, 0.3), p(0.4, 0.4)], 1000, 1000);
		expect(result).toEqual([p(0.1, 0.1), p(0.4, 0.4)]);
	});

	it('measures the snap angle in pixels, not normalized units', () => {
		// 0.3 normalized rise is ~17° on a square page but under 1° on a very wide one.
		const points = [p(0, 0.5), p(1, 0.8)];
		expect(straightenPoints(points, 100, 100)[0]!.y).not.toBe(
			straightenPoints(points, 100, 100)[1]!.y,
		);
		const wide = straightenPoints(points, 2000, 100);
		expect(wide[0]!.y).toBe(wide[1]!.y);
	});

	it('averages pressure and leaves degenerate input alone', () => {
		expect(straightenPoints([p(0, 0, 0.2), p(1, 0, 0.8)], 10, 10)[0]!.pressure).toBeCloseTo(0.5);
		const single = [p(0.3, 0.3)];
		expect(straightenPoints(single, 10, 10)).toBe(single);
		expect(straightenPoints([], 10, 10)).toEqual([]);
	});
});

describe('PointerEventHandler highlighter straightening', () => {
	beforeAll(() => {
		(window as { activeDocument?: Document }).activeDocument = document;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		document.body.innerHTML = '';
	});

	function drawWobblyStroke(tool: 'pen' | 'highlighter', straighten: boolean) {
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
			setTransform: vi.fn(),
			beginPath: vi.fn(),
			moveTo: vi.fn(),
			lineTo: vi.fn(),
			stroke: vi.fn(),
		} as unknown as CanvasRenderingContext2D);
		const strokes = new StrokeStore();
		const deps = {
			palette: { isOpen: () => false, show: vi.fn() },
			strokes,
			overlays: { redrawPage: vi.fn() },
			sidecar: { scheduleSave: vi.fn() },
			undo: { push: vi.fn() },
			toolState: () => ({ tool, color: '#ffeb3b', width: 0.005 }),
			handedness: () => 'right',
			penHold: () => ({ enabled: false, durationMs: 300 }),
			straightenHighlighter: () => straighten,
		} as unknown as PointerEventHandlerDeps;
		const canvas = document.createElement('canvas');
		canvas.setAttribute('data-jot-key', 'doc.pdf::1');
		canvas.getBoundingClientRect = () =>
			({ left: 0, top: 0, width: 600, height: 800 }) as DOMRect;
		document.body.appendChild(canvas);
		new PointerEventHandler(canvas, canvas.getContext('2d')!, deps).attach();

		const path: Array<[number, number]> = [
			[100, 400],
			[150, 404],
			[200, 397],
			[250, 405],
			[300, 398],
			[350, 403],
		];
		const send = (type: string, [clientX, clientY]: [number, number]) =>
			canvas.dispatchEvent(
				new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					pointerId: 7,
					pointerType: 'pen',
					clientX,
					clientY,
					pressure: 0.5,
				}),
			);
		send('pointerdown', path[0]!);
		for (const point of path.slice(1)) send('pointermove', point);
		send('pointerup', path[path.length - 1]!);
		return strokes.forKey('doc.pdf::1');
	}

	it('saves a highlighter stroke as a level straight line', () => {
		const saved = drawWobblyStroke('highlighter', true);
		expect(saved).toHaveLength(1);
		const points = saved[0]!.points;
		expect(points).toHaveLength(2);
		expect(points[0]!.y).toBe(points[1]!.y);
		expect(points[0]!.x * 600).toBeCloseTo(100);
		expect(points[1]!.x * 600).toBeCloseTo(350);
		expect(points[0]!.y * 800).toBeCloseTo(401, 0);
	});

	it('leaves highlighter strokes freehand when the setting is off', () => {
		const saved = drawWobblyStroke('highlighter', false);
		expect(saved[0]!.points.length).toBeGreaterThan(2);
	});

	it('never straightens pen strokes', () => {
		const saved = drawWobblyStroke('pen', true);
		expect(saved[0]!.points.length).toBeGreaterThan(2);
	});
});
