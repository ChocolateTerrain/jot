/* eslint-disable obsidianmd/prefer-active-doc */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	PointerEventHandler,
	type PointerEventHandlerDeps,
} from '../src/pointer-event-handler';
import { StrokeStore } from '../src/stroke-store';
import { TwoFingerDoubleTapDetector } from '../src/two-finger-tap';

function makeDetector() {
	let clock = 0;
	const onDoubleTap = vi.fn();
	const detector = new TwoFingerDoubleTapDetector(
		{ maxTapMs: 250, maxGapMs: 400, movementThresholdPx: 15, now: () => clock },
		onDoubleTap,
	);
	const tick = (ms: number) => (clock += ms);
	const tap = (fingers = 2, holdMs = 80) => {
		for (let i = 0; i < fingers; i++) detector.pointerDown(i, 100 + i * 50, 100);
		tick(holdMs);
		for (let i = 0; i < fingers; i++) detector.pointerUp(i);
	};
	return { detector, onDoubleTap, tick, tap };
}

describe('TwoFingerDoubleTapDetector', () => {
	it('fires on two quick two-finger taps', () => {
		const { onDoubleTap, tick, tap } = makeDetector();
		tap();
		expect(onDoubleTap).not.toHaveBeenCalled();
		tick(150);
		tap();
		expect(onDoubleTap).toHaveBeenCalledOnce();
	});

	it('needs a fresh pair after firing (a triple tap fires once)', () => {
		const { onDoubleTap, tick, tap } = makeDetector();
		tap();
		tick(100);
		tap();
		tick(100);
		tap();
		expect(onDoubleTap).toHaveBeenCalledOnce();
	});

	it('ignores taps that are too far apart', () => {
		const { onDoubleTap, tick, tap } = makeDetector();
		tap();
		tick(600);
		tap();
		expect(onDoubleTap).not.toHaveBeenCalled();
	});

	it('ignores one-finger and three-finger taps', () => {
		const { onDoubleTap, tick, tap } = makeDetector();
		tap(1);
		tick(100);
		tap(1);
		tap(3);
		tick(100);
		tap(3);
		expect(onDoubleTap).not.toHaveBeenCalled();
	});

	it('ignores long presses, so the two-finger hold stays separate', () => {
		const { onDoubleTap, tick, tap } = makeDetector();
		tap(2, 400);
		tick(100);
		tap();
		expect(onDoubleTap).not.toHaveBeenCalled();
	});

	it('ignores pinches and two-finger scrolls', () => {
		const { detector, onDoubleTap, tick, tap } = makeDetector();
		tap();
		tick(100);
		detector.pointerDown(0, 100, 100);
		detector.pointerDown(1, 150, 100);
		detector.pointerMove(1, 220, 100);
		tick(80);
		detector.pointerUp(0);
		detector.pointerUp(1);
		expect(onDoubleTap).not.toHaveBeenCalled();
	});

	it('lets fingers land and lift at slightly different times', () => {
		const { detector, onDoubleTap, tick } = makeDetector();
		for (let round = 0; round < 2; round++) {
			detector.pointerDown(0, 100, 100);
			tick(30);
			detector.pointerDown(1, 150, 100);
			tick(50);
			detector.pointerUp(1);
			tick(20);
			detector.pointerUp(0);
			tick(100);
		}
		expect(onDoubleTap).toHaveBeenCalledOnce();
	});
});

describe('PointerEventHandler two-finger double tap', () => {
	beforeAll(() => {
		(window as { activeDocument?: Document }).activeDocument = document;
	});
	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = '';
	});

	function setup(enabled: boolean) {
		vi.useFakeTimers();
		const undo = vi.fn();
		const onHistoryChange = vi.fn();
		const deps = {
			palette: { isOpen: () => false, show: vi.fn() },
			strokes: new StrokeStore(),
			overlays: { redrawPage: vi.fn() },
			sidecar: { scheduleSave: vi.fn() },
			undo: { push: vi.fn(), undo },
			toolState: () => ({ tool: 'pen', color: '#000000', width: 0.005 }),
			handedness: () => 'right',
			penHold: () => ({ enabled: false, durationMs: 300 }),
			twoFingerDoubleTapUndo: () => enabled,
			onHistoryChange,
		} as unknown as PointerEventHandlerDeps;
		const canvas = document.createElement('canvas');
		canvas.setAttribute('data-jot-key', 'doc.pdf::1');
		document.body.appendChild(canvas);
		new PointerEventHandler(canvas, {} as CanvasRenderingContext2D, deps).attach();
		const finger = (type: string, identifier: number, clientX: number) => {
			const touch = { identifier, clientX, clientY: 200, touchType: 'direct' };
			const list = Object.assign([touch], { item: (i: number) => (i === 0 ? touch : null) });
			const event = new Event(type, { bubbles: true });
			Object.defineProperties(event, {
				changedTouches: { value: list },
				touches: { value: list },
			});
			canvas.dispatchEvent(event);
		};
		const twoFingerTap = (end = 'touchend') => {
			finger('touchstart', 11, 100);
			finger('touchstart', 12, 160);
			vi.advanceTimersByTime(80);
			finger(end, 11, 100);
			finger(end, 12, 160);
			vi.advanceTimersByTime(120);
		};
		return { undo, onHistoryChange, twoFingerTap };
	}

	it('undoes the last stroke', () => {
		const { undo, onHistoryChange, twoFingerTap } = setup(true);
		twoFingerTap();
		twoFingerTap();
		expect(undo).toHaveBeenCalledOnce();
		expect(onHistoryChange).toHaveBeenCalled();
	});

	it('still works when iPadOS cancels the touches to start a pinch', () => {
		const { undo, twoFingerTap } = setup(true);
		twoFingerTap('touchcancel');
		twoFingerTap('touchcancel');
		expect(undo).toHaveBeenCalledOnce();
	});

	it('does nothing when the setting is off', () => {
		const { undo, twoFingerTap } = setup(false);
		twoFingerTap();
		twoFingerTap();
		expect(undo).not.toHaveBeenCalled();
	});
});

describe('two-finger hold palette setting', () => {
	beforeAll(() => {
		(window as { activeDocument?: Document }).activeDocument = document;
	});
	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = '';
	});

	function holdTwoFingers(enabled: boolean) {
		vi.useFakeTimers();
		const show = vi.fn();
		const deps = {
			palette: { isOpen: () => false, show },
			strokes: new StrokeStore(),
			overlays: { redrawPage: vi.fn() },
			sidecar: { scheduleSave: vi.fn() },
			undo: { push: vi.fn(), undo: vi.fn() },
			toolState: () => ({ tool: 'pen', color: '#000000', width: 0.005 }),
			handedness: () => 'right',
			penHold: () => ({ enabled: false, durationMs: 300 }),
			twoFingerHoldOpensPalette: () => enabled,
		} as unknown as PointerEventHandlerDeps;
		const canvas = document.createElement('canvas');
		canvas.setAttribute('data-jot-key', 'doc.pdf::1');
		document.body.appendChild(canvas);
		new PointerEventHandler(canvas, {} as CanvasRenderingContext2D, deps).attach();
		for (const [pointerId, clientX] of [[21, 100], [22, 160]] as const) {
			canvas.dispatchEvent(
				new PointerEvent('pointerdown', { bubbles: true, pointerId, pointerType: 'touch', clientX, clientY: 200 }),
			);
		}
		const indicatorShown = document.querySelector('.jot-hold-indicator') !== null;
		vi.advanceTimersByTime(400);
		return { show, indicatorShown };
	}

	it('opens the palette by default', () => {
		const { show, indicatorShown } = holdTwoFingers(true);
		expect(indicatorShown).toBe(true);
		expect(show).toHaveBeenCalledOnce();
	});

	it('does nothing (not even the hold ring) when turned off', () => {
		const { show, indicatorShown } = holdTwoFingers(false);
		expect(indicatorShown).toBe(false);
		expect(show).not.toHaveBeenCalled();
	});
});
