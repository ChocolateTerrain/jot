/* eslint-disable obsidianmd/prefer-active-doc */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	PointerEventHandler,
	type PointerEventHandlerDeps,
} from '../src/pointer-event-handler';
import { eraseAlongPath, eraseCircleFromStroke, eraserRadiusFor } from '../src/stroke-erase';
import type { NormalizedPoint, Stroke } from '../src/stroke-math';
import { StrokeStore } from '../src/stroke-store';

const page = { width: 1000, height: 1000 };
const p = (x: number, y: number, pressure = 0.5): NormalizedPoint => ({ x, y, pressure });

function line(tool: 'pen' | 'highlighter' = 'pen', points?: NormalizedPoint[]): Stroke {
	return {
		tool,
		color: '#000000',
		width: 0.0025,
		points: points ?? [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((x) => p(x, 0.5)),
	};
}

// Pen half-thickness at pressure 0.5 on a 1000px page: 0.0025 * 1.15 * 1000 / 2.
const PEN_HALF = 1.4375;

describe('eraseCircleFromStroke', () => {
	it('cuts a gap out of the middle and keeps both sides', () => {
		const pieces = eraseCircleFromStroke(line(), 0.5, 0.5, 50, page)!;
		expect(pieces).toHaveLength(2);
		const left = pieces[0]!.points;
		const right = pieces[1]!.points;
		expect(left[0]!.x).toBeCloseTo(0.1);
		expect(left[left.length - 1]!.x * 1000).toBeCloseTo(500 - 50 - PEN_HALF, 3);
		expect(right[0]!.x * 1000).toBeCloseTo(500 + 50 + PEN_HALF, 3);
		expect(right[right.length - 1]!.x).toBeCloseTo(0.9);
		expect(pieces[0]!.color).toBe('#000000');
	});

	it('cuts a straightened two-point highlighter line with no points inside the circle', () => {
		const stroke = line('highlighter', [p(0.1, 0.5), p(0.9, 0.5)]);
		const pieces = eraseCircleFromStroke(stroke, 0.5, 0.5, 20, page)!;
		expect(pieces).toHaveLength(2);
		// Highlighter half-thickness: 0.0025 * 4 * 1000 / 2 = 5px.
		expect(pieces[0]!.points[1]!.x * 1000).toBeCloseTo(475, 3);
		expect(pieces[1]!.points[0]!.x * 1000).toBeCloseTo(525, 3);
	});

	it('shortens the line when erasing its end', () => {
		const pieces = eraseCircleFromStroke(line(), 0.9, 0.5, 50, page)!;
		expect(pieces).toHaveLength(1);
		const pts = pieces[0]!.points;
		expect(pts[0]!.x).toBeCloseTo(0.1);
		expect(pts[pts.length - 1]!.x * 1000).toBeCloseTo(900 - 50 - PEN_HALF, 3);
	});

	it('removes a stroke that is fully covered', () => {
		const small = line('pen', [p(0.5, 0.5), p(0.51, 0.5)]);
		expect(eraseCircleFromStroke(small, 0.5, 0.5, 50, page)).toEqual([]);
	});

	it('returns null when the eraser misses, including just past the ink edge', () => {
		expect(eraseCircleFromStroke(line(), 0.5, 0.7, 50, page)).toBeNull();
		// Centerline 50 + 1.44 px away from a 50px eraser: outside the ink.
		expect(eraseCircleFromStroke(line(), 0.5, 0.5 + 0.0515, 50, page)).toBeNull();
		// ...but touching the ink edge does erase.
		expect(eraseCircleFromStroke(line(), 0.5, 0.5 + 0.0510, 50, page)).not.toBeNull();
	});

	it('keeps the original pen thickness by preserving average pressure', () => {
		const stroke = line('pen', [p(0.1, 0.5, 0.2), p(0.3, 0.5, 0.9), p(0.5, 0.5, 0.2), p(0.7, 0.5, 0.9), p(0.9, 0.5, 0.3)]);
		const avg = 2.5 / 5;
		const pieces = eraseCircleFromStroke(stroke, 0.5, 0.5, 30, page)!;
		for (const piece of pieces) {
			for (const point of piece.points) expect(point.pressure).toBeCloseTo(avg);
		}
	});
});

describe('eraseAlongPath', () => {
	it('catches a line crossed by a fast swipe between two samples', () => {
		const stroke = line();
		const next = eraseAlongPath([stroke], { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }, 5, page)!;
		expect(next).toHaveLength(2);
	});

	it('returns null and leaves strokes alone when nothing is touched', () => {
		expect(eraseAlongPath([line()], { x: 0.1, y: 0.8 }, { x: 0.9, y: 0.8 }, 10, page)).toBeNull();
	});

	it('scales the eraser with the selected size', () => {
		expect(eraserRadiusFor(0.0015)).toBeLessThan(eraserRadiusFor(0.009));
	});
});

describe('PointerEventHandler partial eraser', () => {
	beforeAll(() => {
		(window as { activeDocument?: Document }).activeDocument = document;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		document.body.innerHTML = '';
	});

	function setup() {
		const strokes = new StrokeStore();
		strokes.appendToKey('doc.pdf::1', line());
		const push = vi.fn();
		const deps = {
			palette: { isOpen: () => false, show: vi.fn() },
			strokes,
			overlays: { redrawPage: vi.fn() },
			sidecar: { scheduleSave: vi.fn() },
			undo: { push },
			toolState: () => ({ tool: 'eraser', color: '#000000', width: 0.005 }),
			handedness: () => 'right',
			penHold: () => ({ enabled: false, durationMs: 300 }),
		} as unknown as PointerEventHandlerDeps;
		const canvas = document.createElement('canvas');
		canvas.setAttribute('data-jot-key', 'doc.pdf::1');
		canvas.getBoundingClientRect = () =>
			({ left: 0, top: 0, width: 1000, height: 1000 }) as DOMRect;
		document.body.appendChild(canvas);
		new PointerEventHandler(canvas, {} as CanvasRenderingContext2D, deps).attach();
		const pen = (type: string, clientX: number, clientY: number, buttons = 1) =>
			canvas.dispatchEvent(
				new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					pointerId: 5,
					pointerType: 'pen',
					clientX,
					clientY,
					buttons,
					pressure: buttons ? 0.5 : 0,
				}),
			);
		return { strokes, push, pen };
	}

	it('splits the line instead of deleting it, with one undo step', () => {
		const { strokes, push, pen } = setup();
		pen('pointerdown', 500, 400);
		pen('pointermove', 500, 450);
		expect(document.querySelector('.jot-eraser-cursor')).not.toBeNull();
		pen('pointermove', 500, 600);
		pen('pointerup', 500, 600);

		const pieces = strokes.forKey('doc.pdf::1');
		expect(pieces).toHaveLength(2);
		expect(push).toHaveBeenCalledOnce();
		expect(document.querySelector('.jot-eraser-cursor')).toBeNull();
	});

	it('sizes the cursor circle to the eraser and follows the pencil', () => {
		const { pen } = setup();
		pen('pointerdown', 300, 300);
		const cursor = document.querySelector<HTMLElement>('.jot-eraser-cursor')!;
		const diameter = 2 * eraserRadiusFor(0.005) * 1000;
		expect(parseFloat(cursor.style.width)).toBeCloseTo(diameter);
		expect(cursor.style.transform).toBe(`translate(${300 - diameter / 2}px, ${300 - diameter / 2}px)`);
		pen('pointerup', 300, 300);
	});

	it('shows the circle while hovering with the eraser selected', () => {
		const { strokes, pen } = setup();
		pen('pointermove', 500, 500, 0);
		expect(document.querySelector('.jot-eraser-cursor')).not.toBeNull();
		expect(strokes.forKey('doc.pdf::1')).toHaveLength(1);
		pen('pointerleave', 500, 500, 0);
		expect(document.querySelector('.jot-eraser-cursor')).toBeNull();
	});

	it('erases on a tap without moving', () => {
		const { strokes, pen } = setup();
		pen('pointerdown', 500, 500);
		pen('pointerup', 500, 500);
		expect(strokes.forKey('doc.pdf::1')).toHaveLength(2);
	});
});
