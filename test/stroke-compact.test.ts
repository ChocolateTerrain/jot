/* eslint-disable obsidianmd/prefer-active-doc */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DrawingPreview } from '../src/drawing-preview';
import {
	PointerEventHandler,
	type PointerEventHandlerDeps,
} from '../src/pointer-event-handler';
import { compactPoints, roundPoint } from '../src/stroke-compact';
import type { NormalizedPoint } from '../src/stroke-math';
import { StrokeStore } from '../src/stroke-store';

const p = (x: number, y: number, pressure = 0.5): NormalizedPoint => ({ x, y, pressure });

describe('compactPoints', () => {
	it('drops pencil samples closer than 0.75 px but keeps the ends', () => {
		// 101 samples 0.2 px apart along a 20 px line on a 1000 px page.
		const dense = Array.from({ length: 101 }, (_, i) => p(0.1 + i * 0.0002, 0.5));
		const out = compactPoints(dense, 1000, 1000);
		expect(out.length).toBeLessThan(30);
		expect(out[0]).toEqual(roundPoint(dense[0]!));
		expect(out[out.length - 1]).toEqual(roundPoint(dense[100]!));
	});

	it('keeps every point of a stroke that is already sparse', () => {
		const sparse = [p(0.1, 0.1), p(0.2, 0.15), p(0.3, 0.1)];
		expect(compactPoints(sparse, 1000, 1000)).toHaveLength(3);
	});

	it('never moves a point by a visible amount', () => {
		const point = p(0.123456789, 0.987654321, 0.33333333);
		const r = roundPoint(point);
		expect(Math.abs(r.x - point.x) * 2000).toBeLessThan(0.02);
		expect(Math.abs(r.y - point.y) * 2000).toBeLessThan(0.02);
		expect(r.pressure).toBe(0.333);
	});
});

describe('drawing performance', () => {
	beforeAll(() => {
		(window as { activeDocument?: Document }).activeDocument = document;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		document.body.innerHTML = '';
	});

	it('reuses one preview canvas instead of allocating one per stroke', () => {
		const host = document.body.appendChild(document.createElement('div'));
		const source = host.appendChild(document.createElement('canvas'));
		source.width = 300;
		source.height = 400;
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
			setTransform: vi.fn(),
			clearRect: vi.fn(),
			beginPath: vi.fn(),
			moveTo: vi.fn(),
			lineTo: vi.fn(),
			stroke: vi.fn(),
		} as unknown as CanvasRenderingContext2D);
		const first = DrawingPreview.create(source, 'pen')!;
		const firstCanvas = host.querySelector('.jot-drawing-preview');
		first.destroy();
		expect(host.querySelector('.jot-drawing-preview')).toBeNull();
		DrawingPreview.create(source, 'highlighter');
		expect(host.querySelector('.jot-drawing-preview')).toBe(firstCanvas);
	});

	it('measures the page once per stroke, not on every pencil movement', () => {
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
			setTransform: vi.fn(),
			clearRect: vi.fn(),
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
			toolState: () => ({ tool: 'pen', color: '#000000', width: 0.005 }),
			handedness: () => 'right',
			penHold: () => ({ enabled: false, durationMs: 300 }),
		} as unknown as PointerEventHandlerDeps;
		const canvas = document.body.appendChild(document.createElement('canvas'));
		canvas.setAttribute('data-jot-key', 'doc.pdf::1');
		const measure = vi.fn(() => ({ left: 0, top: 0, width: 600, height: 800 }) as DOMRect);
		canvas.getBoundingClientRect = measure;
		new PointerEventHandler(canvas, canvas.getContext('2d')!, deps).attach();
		const pen = (type: string, x: number) =>
			canvas.dispatchEvent(
				new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'pen', clientX: x, clientY: 300, pressure: 0.5, buttons: 1 }),
			);
		pen('pointerdown', 100);
		for (let x = 105; x <= 400; x += 5) pen('pointermove', x);
		pen('pointerup', 400);
		expect(measure).toHaveBeenCalledTimes(1);
		expect(strokes.forKey('doc.pdf::1')).toHaveLength(1);
	});
});
