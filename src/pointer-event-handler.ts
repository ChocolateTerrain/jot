import { readCanvasSurface } from './canvas-surface';
import { createHoldIndicator } from './hold-indicator';
import { pdfPathFromKey } from './jot-file';
import { LongPressDetector } from './long-press';
import type { Handedness, Palette, ToolState } from './palette';
import { OVERLAY_KEY_ATTR, OverlayManager } from './overlay-manager';
import type { PenHoldSettings } from './pen-hold';
import { PenStrokeState } from './pen-stroke-state';
import type { SidecarStore } from './sidecar-store';
import {
	ERASE_RADIUS,
	NormalizedPoint,
	Stroke,
	strokeIntersects,
} from './stroke-math';
import { drawHighlighterPolyline, drawSegment } from './stroke-render';
import type { StrokeStore } from './stroke-store';
import { StylusGestureGuard } from './stylus-gesture-guard';
import { TwoFingerHoldDetector } from './two-finger-hold';
import type { UndoController } from './undo-controller';

const LONG_PRESS_MOVE_PX = 15;
const TWO_FINGER_HOLD_MS = 300;
const TWO_FINGER_MOVE_PX = 25;

export interface PointerEventHandlerDeps {
	palette: Palette;
	strokes: StrokeStore;
	overlays: OverlayManager;
	sidecar: SidecarStore;
	undo: UndoController;
	toolState: () => ToolState;
	handedness: () => Handedness;
	penHold: () => PenHoldSettings;
}

export class PointerEventHandler {
	private state = new PenStrokeState();
	private activePointerId: number | null = null;
	private highlighterFrame: number | null = null;
	private stylusTouchId: number | null = null;
	private holdIndicator: HTMLElement | null = null;
	private twoFingerIndicator: HTMLElement | null = null;
	private stylusGuard = new StylusGestureGuard();
	private longPress: LongPressDetector;
	private twoFingerHold: TwoFingerHoldDetector;

	constructor(
		private canvas: HTMLCanvasElement,
		private ctx: CanvasRenderingContext2D,
		private deps: PointerEventHandlerDeps,
	) {
		this.longPress = new LongPressDetector(
			{ durationMs: deps.penHold().durationMs, movementThresholdPx: LONG_PRESS_MOVE_PX },
			{
				onFire: () => this.onLongPressFire(),
				onCancel: () => this.removeHoldIndicator(),
			},
		);
		this.twoFingerHold = new TwoFingerHoldDetector(
			{ durationMs: TWO_FINGER_HOLD_MS, movementThresholdPx: TWO_FINGER_MOVE_PX },
			{
				onArm: (cx, cy) => this.onTwoFingerArm(cx, cy),
				onFire: (cx, cy) => this.onTwoFingerFire(cx, cy),
				onDisarm: () => this.removeTwoFingerIndicator(),
			},
		);
	}

	attach(): void {
		this.blockStylusGesturePreemption();
		this.canvas.addEventListener('touchstart', (e) => this.onStylusTouchStart(e), {
			passive: false,
		});
		this.canvas.addEventListener('touchmove', (e) => this.onStylusTouchMove(e), {
			passive: false,
		});
		this.canvas.addEventListener('touchend', (e) => this.onStylusTouchFinish(e));
		this.canvas.addEventListener('touchcancel', (e) => this.onStylusTouchFinish(e));
		this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
		this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
		this.canvas.addEventListener('pointerup', (e) => this.onFinish(e));
		this.canvas.addEventListener('pointercancel', (e) => this.onFinish(e));
	}

	private onPointerDown(e: PointerEvent): void {
		if (e.pointerType === 'pen') this.stylusGuard.penDown(e.pointerId);
		if (e.pointerType === 'touch') {
			this.twoFingerHold.pointerDown(e.pointerId, e.clientX, e.clientY);
			return;
		}
		if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') return;
		if (this.stylusTouchId !== null) return;
		if (this.deps.palette.isOpen()) return;

		try {
			this.canvas.setPointerCapture(e.pointerId);
		} catch {
			// Pointer capture is optional; the page-sized overlay still receives input.
		}
		this.activePointerId = e.pointerId;
		this.beginInputAt(e.clientX, e.clientY, e.pressure);
		e.preventDefault();
	}

	private onPointerMove(e: PointerEvent): void {
		if (e.pointerType === 'touch') {
			this.twoFingerHold.pointerMove(e.pointerId, e.clientX, e.clientY);
			return;
		}
		if (this.stylusTouchId !== null) return;
		this.longPress.move(e.clientX, e.clientY);
		if (this.state.isErasing()) {
			if (this.eraseAt(e.clientX, e.clientY)) this.state.markErased();
			e.preventDefault();
			return;
		}
		this.continueDrawingAt(e.clientX, e.clientY, e.pressure);
	}

	private onFinish(e: PointerEvent): void {
		if (e.pointerType === 'pen') this.stylusGuard.penUp(e.pointerId);
		if (e.pointerType === 'touch') {
			this.twoFingerHold.pointerUp(e.pointerId);
			return;
		}
		if (this.stylusTouchId !== null) return;
		this.longPress.cancel();
		this.cancelHighlighterRedraw();
		if (this.state.isErasing()) {
			this.finalizeEraserGesture();
			this.releasePointerCapture();
			return;
		}
		if (this.state.isDrawing()) {
			this.finalizeDrawingStroke();
			window.requestAnimationFrame(() => this.deps.overlays.redrawPage(this.canvas));
		}
		this.releasePointerCapture();
	}

	private onLongPressFire(): void {
		this.removeHoldIndicator();
		this.cancelHighlighterRedraw();
		const { clientX, clientY } = this.state.pressedAt;
		this.state.reset();
		this.deps.overlays.redrawPage(this.canvas);
		this.releasePointerCapture();
		this.openPaletteAt(clientX, clientY);
	}

	private onTwoFingerArm(cx: number, cy: number): void {
		if (this.deps.palette.isOpen() || this.state.isBusy()) {
			this.twoFingerHold.cancel();
			return;
		}
		this.twoFingerIndicator = createHoldIndicator(activeDocument, cx, cy, TWO_FINGER_HOLD_MS);
		activeDocument.body.appendChild(this.twoFingerIndicator);
	}

	private onTwoFingerFire(cx: number, cy: number): void {
		if (this.deps.palette.isOpen()) return;
		this.openPaletteAt(cx, cy);
	}

	private beginInputAt(clientX: number, clientY: number, pressure: number): void {
		this.state.beginAt(clientX, clientY, this.deps.toolState().tool, () =>
			this.snapshotCurrent(),
		);
		if (this.state.isDrawing()) {
			this.state.appendDrawingPoint(this.toNormalized(clientX, clientY, pressure));
		}
		const penHold = this.deps.penHold();
		if (penHold.enabled) {
			this.showHoldIndicator(clientX, clientY, penHold.durationMs);
			this.longPress.start(clientX, clientY, penHold.durationMs);
		}
	}

	private continueDrawingAt(clientX: number, clientY: number, pressure: number): void {
		if (!this.state.isDrawing()) return;
		const previous = this.state.lastDrawingPoint();
		if (!previous) return;
		const next = this.toNormalized(clientX, clientY, pressure);
		this.state.appendDrawingPoint(next);
		const surface = readCanvasSurface(this.canvas);
		const tool = this.deps.toolState();
		if (tool.tool === 'highlighter') {
			this.scheduleHighlighterRedraw();
		} else {
			drawSegment(this.ctx, previous, next, tool.color, tool.width, surface);
		}
	}

	private scheduleHighlighterRedraw(): void {
		if (this.highlighterFrame !== null) return;
		this.highlighterFrame = window.requestAnimationFrame(() => {
			this.highlighterFrame = null;
			if (!this.state.isDrawing()) return;
			const tool = this.deps.toolState();
			if (tool.tool !== 'highlighter') return;
			this.deps.overlays.redrawPage(this.canvas);
			drawHighlighterPolyline(
				this.ctx,
				this.state.drawingPoints(),
				tool.color,
				tool.width,
				readCanvasSurface(this.canvas),
			);
		});
	}

	private cancelHighlighterRedraw(): void {
		if (this.highlighterFrame === null) return;
		window.cancelAnimationFrame(this.highlighterFrame);
		this.highlighterFrame = null;
	}

	private finalizeEraserGesture(): void {
		const snapshot = this.state.takeEraserSnapshot();
		if (snapshot) this.deps.undo.push(snapshot);
		this.state.reset();
	}

	private finalizeDrawingStroke(): void {
		const points = this.state.drawingPoints();
		const key = this.canvas.getAttribute(OVERLAY_KEY_ATTR);
		if (key && points.length > 0) {
			const pdfPath = pdfPathFromKey(key);
			const tool = this.deps.toolState();
			if (pdfPath) {
				this.deps.undo.push({ pdfPath, key, prevStrokes: [...this.deps.strokes.forKey(key)] });
			}
			this.deps.strokes.appendToKey(key, {
				points,
				color: tool.color,
				width: tool.width,
				tool: tool.tool,
			});
			if (pdfPath) this.deps.sidecar.scheduleSave(pdfPath);
		}
		this.state.reset();
	}

	private eraseAt(clientX: number, clientY: number): boolean {
		const key = this.canvas.getAttribute(OVERLAY_KEY_ATTR);
		if (!key) return false;
		const strokes = this.deps.strokes.forKey(key);
		if (strokes.length === 0) return false;
		const rect = this.canvas.getBoundingClientRect();
		const x = (clientX - rect.left) / rect.width;
		const y = (clientY - rect.top) / rect.height;
		const kept: Stroke[] = [];
		let removed = 0;
		for (const stroke of strokes) {
			if (strokeIntersects(stroke, x, y, ERASE_RADIUS)) {
				removed += 1;
			} else {
				kept.push(stroke);
			}
		}
		if (removed === 0) return false;
		this.deps.strokes.setForKey(key, kept);
		this.deps.overlays.redrawPage(this.canvas);
		const pdfPath = pdfPathFromKey(key);
		if (pdfPath) this.deps.sidecar.scheduleSave(pdfPath);
		return true;
	}

	private snapshotCurrent() {
		const key = this.canvas.getAttribute(OVERLAY_KEY_ATTR);
		if (!key) return null;
		const pdfPath = pdfPathFromKey(key);
		if (!pdfPath) return null;
		return { pdfPath, key, prevStrokes: [...this.deps.strokes.forKey(key)] };
	}

	private openPaletteAt(x: number, y: number): void {
		this.deps.palette.show(activeDocument.body, x, y, this.deps.handedness());
	}

	private showHoldIndicator(x: number, y: number, durationMs: number): void {
		this.holdIndicator = createHoldIndicator(activeDocument, x, y, durationMs);
		activeDocument.body.appendChild(this.holdIndicator);
	}

	private removeHoldIndicator(): void {
		this.holdIndicator?.remove();
		this.holdIndicator = null;
	}

	private removeTwoFingerIndicator(): void {
		this.twoFingerIndicator?.remove();
		this.twoFingerIndicator = null;
	}

	private releasePointerCapture(): void {
		if (this.activePointerId === null) return;
		try {
			this.canvas.releasePointerCapture(this.activePointerId);
		} catch {
			/* already released */
		}
		this.activePointerId = null;
	}

	private toNormalized(clientX: number, clientY: number, pressure: number): NormalizedPoint {
		const rect = this.canvas.getBoundingClientRect();
		return {
			x: (clientX - rect.left) / rect.width,
			y: (clientY - rect.top) / rect.height,
			pressure,
		};
	}

	private onStylusTouchStart(e: TouchEvent): void {
		if (this.activePointerId !== null || this.stylusTouchId !== null) return;
		const touch = this.stylusTouchFrom(e.changedTouches);
		if (!touch) return;
		this.twoFingerHold.cancel();
		this.stylusTouchId = touch.identifier;
		this.beginInputAt(touch.clientX, touch.clientY, touch.force || 0.5);
		e.preventDefault();
	}

	private onStylusTouchMove(e: TouchEvent): void {
		if (this.stylusTouchId === null) return;
		const touch = this.stylusTouchFrom(e.changedTouches, this.stylusTouchId);
		if (!touch) return;
		this.longPress.move(touch.clientX, touch.clientY);
		if (this.state.isErasing()) {
			if (this.eraseAt(touch.clientX, touch.clientY)) this.state.markErased();
		} else {
			this.continueDrawingAt(touch.clientX, touch.clientY, touch.force || 0.5);
		}
		e.preventDefault();
	}

	private onStylusTouchFinish(e: TouchEvent): void {
		if (this.stylusTouchId === null) return;
		const touch = this.stylusTouchFrom(e.changedTouches, this.stylusTouchId);
		if (!touch) return;
		this.stylusTouchId = null;
		this.longPress.cancel();
		this.cancelHighlighterRedraw();
		if (this.state.isErasing()) {
			this.finalizeEraserGesture();
		} else if (this.state.isDrawing()) {
			this.finalizeDrawingStroke();
			window.requestAnimationFrame(() => this.deps.overlays.redrawPage(this.canvas));
		}
	}

	private stylusTouchFrom(touches: TouchList, identifier?: number): Touch | null {
		for (let index = 0; index < touches.length; index++) {
			const touch = touches.item(index);
			if (!touch || (identifier !== undefined && touch.identifier !== identifier)) continue;
			if ((touch as Touch & { touchType?: string }).touchType === 'stylus') return touch;
		}
		return null;
	}

	private blockStylusGesturePreemption(): void {
		const blockStylus = (e: TouchEvent) => {
			if (this.stylusGuard.shouldBlock(Array.from(e.touches))) e.preventDefault();
		};
		this.canvas.addEventListener('touchstart', blockStylus, { passive: false });
		this.canvas.addEventListener('touchmove', blockStylus, { passive: false });
		const resetWhenAllLifted = (e: TouchEvent) => {
			if (e.touches.length === 0) this.stylusGuard.reset();
		};
		this.canvas.addEventListener('touchend', resetWhenAllLifted);
		this.canvas.addEventListener('touchcancel', resetWhenAllLifted);
	}
}
