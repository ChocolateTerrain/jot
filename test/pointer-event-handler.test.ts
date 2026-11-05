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

describe('PointerEventHandler', () => {
	it('continues pen input when pointer capture is unavailable', () => {
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
		new PointerEventHandler(canvas, {} as CanvasRenderingContext2D, deps).attach();

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
			new PointerEvent('pointerup', {
				bubbles: true,
				pointerId: 1,
				pointerType: 'pen',
				clientX: 20,
				clientY: 30,
				pressure: 0,
			}),
		);

		expect(strokes.forKey('doc.pdf::1')).toHaveLength(1);
		expect(scheduleSave).toHaveBeenCalledOnce();

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
});