/* eslint-disable obsidianmd/prefer-active-doc */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	PointerEventHandler,
	type PointerEventHandlerDeps,
} from '../src/pointer-event-handler';
import { StrokeStore } from '../src/stroke-store';

beforeAll(() => {
	(window as { activeDocument?: Document }).activeDocument = document;
});

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = '';
});

function makeStylusTouch(identifier: number, clientX: number, clientY: number): Touch {
	return {
		identifier,
		clientX,
		clientY,
		force: 0.5,
		touchType: 'stylus',
	} as unknown as Touch;
}

function makeTouchList(touches: Touch[]): TouchList {
	const list = touches as Touch[] & { item: (index: number) => Touch | null };
	list.item = (index) => list[index] ?? null;
	return list;
}

function makeDrawingContext(): CanvasRenderingContext2D {
	return {
		setTransform: vi.fn(),
		beginPath: vi.fn(),
		moveTo: vi.fn(),
		lineTo: vi.fn(),
		stroke: vi.fn(),
	} as unknown as CanvasRenderingContext2D;
}

function dispatchTouch(
	canvas: HTMLCanvasElement,
	type: string,
	touch: Touch,
	activeTouches: Touch[],
): void {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		changedTouches: { value: makeTouchList([touch]) },
		touches: { value: makeTouchList(activeTouches) },
	});
	canvas.dispatchEvent(event);
}

describe('PointerEventHandler', () => {
	it('ignores a light pen tap and continues input when pointer capture is unavailable', () => {
		vi.useFakeTimers();
		const strokes = new StrokeStore();
		const showPalette = vi.fn();
		const scheduleSave = vi.fn();
		const deps = {
			palette: { isOpen: () => false, show: showPalette },
			strokes,
			overlays: { redrawPage: vi.fn() },
			sidecar: { scheduleSave },
			undo: { push: vi.fn() },
			toolState: () => ({ tool: 'pen', color: '#000000', width: 0.005 }),
			handedness: () => 'right',
			penHold: () => ({ enabled: true, durationMs: 300 }),
		} as unknown as PointerEventHandlerDeps;
		const canvas = document.createElement('canvas');
		canvas.setAttribute('data-jot-key', 'doc.pdf::1');
		canvas.getBoundingClientRect = () =>
			({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
		canvas.setPointerCapture = () => {
			throw new Error('pointer capture unavailable');
		};
		document.body.appendChild(canvas);
		new PointerEventHandler(canvas, makeDrawingContext(), deps).attach();

		canvas.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				cancelable: true,
				pointerId: 1,
				pointerType: 'pen',
				clientX: 20,
				clientY: 30,
				pressure: 0.5,
			}),
		);
		canvas.dispatchEvent(
			new PointerEvent('pointermove', {
				bubbles: true,
				pointerId: 1,
				pointerType: 'pen',
				clientX: 21,
				clientY: 30,
				pressure: 0.5,
			}),
		);
		canvas.dispatchEvent(
			new PointerEvent('pointerup', {
				bubbles: true,
				pointerId: 1,
				pointerType: 'pen',
				clientX: 20,
				clientY: 30,
				pressure: 0,
			}),
		);

		expect(strokes.forKey('doc.pdf::1')).toHaveLength(0);
		expect(scheduleSave).not.toHaveBeenCalled();

		canvas.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				cancelable: true,
				pointerId: 2,
				pointerType: 'pen',
				clientX: 40,
				clientY: 50,
				pressure: 0.5,
			}),
		);
		vi.advanceTimersByTime(300);

		expect(showPalette).toHaveBeenCalledOnce();
	});

	it('uses iOS stylus Touch Events for strokes and pen holds', () => {
		vi.useFakeTimers();
		const strokes = new StrokeStore();
		const showPalette = vi.fn();
		const scheduleSave = vi.fn();
		const deps = {
			palette: { isOpen: () => false, show: showPalette },
			strokes,
			overlays: { redrawPage: vi.fn() },
			sidecar: { scheduleSave },
			undo: { push: vi.fn() },
			toolState: () => ({ tool: 'pen', color: '#000000', width: 0.005 }),
			handedness: () => 'right',
			penHold: () => ({ enabled: true, durationMs: 300 }),
		} as unknown as PointerEventHandlerDeps;
		const canvas = document.createElement('canvas');
		canvas.setAttribute('data-jot-key', 'doc.pdf::1');
		canvas.getBoundingClientRect = () =>
			({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
		document.body.appendChild(canvas);
		new PointerEventHandler(canvas, makeDrawingContext(), deps).attach();

		const touch = makeStylusTouch(1, 20, 30);
		const movedTouch = makeStylusTouch(1, 40, 50);
		canvas.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				pointerId: 1,
				pointerType: 'touch',
				clientX: 20,
				clientY: 30,
			}),
		);
		dispatchTouch(canvas, 'touchstart', touch, [touch]);
		dispatchTouch(canvas, 'touchmove', movedTouch, [movedTouch]);
		dispatchTouch(canvas, 'touchend', touch, []);
		canvas.dispatchEvent(
			new PointerEvent('pointerup', {
				bubbles: true,
				pointerId: 1,
				pointerType: 'touch',
				clientX: 20,
				clientY: 30,
			}),
		);

		expect(strokes.forKey('doc.pdf::1')).toHaveLength(1);
		expect(strokes.forKey('doc.pdf::1')[0]?.points).toHaveLength(2);
		expect(scheduleSave).toHaveBeenCalledOnce();

		const holdTouch = makeStylusTouch(2, 40, 50);
		dispatchTouch(canvas, 'touchstart', holdTouch, [holdTouch]);
		vi.advanceTimersByTime(300);
		expect(showPalette).toHaveBeenCalledOnce();
		dispatchTouch(canvas, 'touchend', holdTouch, []);
	});
});