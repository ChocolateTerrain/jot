import { readCanvasSurface } from './canvas-surface';
import { createHoldIndicator } from './hold-indicator';
import { DrawingPreview } from './drawing-preview';
import { pdfPathFromKey } from './jot-file';
import { LongPressDetector } from './long-press';
import type { Handedness, Palette, ToolState } from './palette';
import { OVERLAY_KEY_ATTR, OverlayManager } from './overlay-manager';
import type { PenHoldSettings } from './pen-hold';
import { PenStrokeState } from './pen-stroke-state';
import type { SidecarStore } from './sidecar-store';
import type { NormalizedPoint } from './stroke-math';
import { eraseAlongPath, eraserRadiusFor } from './stroke-erase';
import type { StrokeStore } from './stroke-store';
import { straightenPoints } from './stroke-straighten';
import { StylusGestureGuard } from './stylus-gesture-guard';
import { TwoFingerHoldDetector } from './two-finger-hold';
import { TwoFingerDoubleTapDetector } from './two-finger-tap';
import type { UndoController } from './undo-controller';

const LONG_PRESS_MOVE_PX = 15;
const TWO_FINGER_HOLD_MS = 300;
const TWO_FINGER_MOVE_PX = 25;
const MIN_STROKE_MOVEMENT_PX = 2;
const TWO_FINGER_TAP_MAX_MS = 250;
const TWO_FINGER_TAP_GAP_MS = 500;
const TWO_FINGER_TAP_MOVE_PX = 15;

export interface PointerEventHandlerDeps {
	palette: Palette;
	strokes: StrokeStore;
	overlays: OverlayManager;
	sidecar: SidecarStore;
	undo: UndoController;
	toolState: () => ToolState;
	handedness: () => Handedness;
	penHold: () => PenHoldSettings;
	straightenHighlighter?: () => boolean;
	twoFingerDoubleTapUndo?: () => boolean;
	onHistoryChange?: () => void;
}

export class PointerEventHandler {
	private state = new PenStrokeState();
	private activePointerId: number | null = null;
	private drawingPreview: DrawingPreview | null = null;
	private stylusTouchId: number | null = null;
	private holdIndicator: HTMLElement | null = null;
	private twoFingerIndicator: HTMLElement | null = null;
	private stylusGuard = new StylusGestureGuard();
	private longPress: LongPressDetector;
	private twoFingerHold: TwoFingerHoldDetector;
	private twoFingerTap: TwoFingerDoubleTapDetector;
	private eraserCursor: HTMLElement | null = null;
	/** Last eraser position (normalized) this gesture, and whether it has moved. */
	private lastErase: { x: number; y: number } | null = null;
	private eraserMoved = false;

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
		this.twoFingerTap = new TwoFingerDoubleTapDetector(
			{
				maxTapMs: TWO_FINGER_TAP_MAX_MS,
				maxGapMs: TWO_FINGER_TAP_GAP_MS,
				movementThresholdPx: TWO_FINGER_TAP_MOVE_PX,
			},
			() => this.onTwoFingerDoubleTap(),
		);
	}

	attach(): void {
		this.blockStylusGesturePreemption();
		this.trackFingerTaps();
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
		this.canvas.addEventListener('pointerleave', () => {
			if (!this.state.isErasing()) this.hideEraserCursor();
		});
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
		if (!this.state.isBusy()) {
			// Apple Pencil hover (or a mouse) over the page: preview the eraser size.
			if (this.deps.toolState().tool === 'eraser' && !this.deps.palette.isOpen()) {
				this.showEraserCursor(e.clientX, e.clientY);
			} else {
				this.hideEraserCursor();
			}
			return;
		}
		this.longPress.move(e.clientX, e.clientY);
		if (this.state.isErasing()) {
			this.eraseMoveTo(e.clientX, e.clientY);
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
		this.hideEraserCursor();
		this.lastErase = null;
		this.destroyDrawingPreview();
		const { clientX, clientY } = this.state.pressedAt;
		this.state.reset();
		this.deps.overlays.redrawPage(this.canvas);
		this.releasePointerCapture();
		this.openPaletteAt(clientX, clientY);
	}

	private onTwoFingerDoubleTap(): void {
		if (!(this.deps.twoFingerDoubleTapUndo?.() ?? false)) return;
		if (this.deps.palette.isOpen() || this.state.isBusy()) return;
		this.twoFingerHold.cancel();
		this.deps.undo.undo();
		this.deps.onHistoryChange?.();
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
			this.drawingPreview = DrawingPreview.create(this.canvas, this.deps.toolState().tool);
		}
		if (this.state.isErasing()) {
			const p = this.toNormalized(clientX, clientY, 0);
			this.lastErase = { x: p.x, y: p.y };
			this.eraserMoved = false;
			this.showEraserCursor(clientX, clientY);
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
		const tool = this.deps.toolState();
		this.drawingPreview?.drawSegment(
			previous,
			next,
			tool.color,
			tool.width,
			readCanvasSurface(this.canvas),
		);
	}

	private destroyDrawingPreview(): void {
		this.drawingPreview?.destroy();
		this.drawingPreview = null;
	}

	private finalizeEraserGesture(): void {
		// A tap without moving erases under the pencil too.
		if (!this.eraserMoved && this.lastErase && this.eraseSegment(null, this.lastErase)) {
			this.state.markErased();
		}
		this.lastErase = null;
		this.hideEraserCursor();
		const snapshot = this.state.takeEraserSnapshot();
		if (snapshot) this.deps.undo.push(snapshot);
		this.state.reset();
		this.deps.onHistoryChange?.();
	}

	private finalizeDrawingStroke(): void {
		const points = this.state.drawingPoints();
		const key = this.canvas.getAttribute(OVERLAY_KEY_ATTR);
		const firstPoint = points[0];
		const rect = this.canvas.getBoundingClientRect();
		const movedEnough =
			firstPoint !== undefined &&
			points.some(
				(point) =>
					Math.hypot(
						(point.x - firstPoint.x) * rect.width,
						(point.y - firstPoint.y) * rect.height,
					) >= MIN_STROKE_MOVEMENT_PX,
			);
		if (key && movedEnough) {
			const pdfPath = pdfPathFromKey(key);
			const tool = this.deps.toolState();
			if (pdfPath) {
				this.deps.undo.push({ pdfPath, key, prevStrokes: [...this.deps.strokes.forKey(key)] });
			}
			const straighten =
				tool.tool === 'highlighter' && (this.deps.straightenHighlighter?.() ?? false);
			this.deps.strokes.appendToKey(key, {
				points: straighten ? straightenPoints(points, rect.width, rect.height) : points,
				color: tool.color,
				width: tool.width,
				tool: tool.tool,
			});
			if (pdfPath) this.deps.sidecar.scheduleSave(pdfPath);
		}
		this.state.reset();
		this.destroyDrawingPreview();
		this.deps.onHistoryChange?.();
	}

	private eraseMoveTo(clientX: number, clientY: number): void {
		this.longPress.move(clientX, clientY);
		this.showEraserCursor(clientX, clientY);
		const p = this.toNormalized(clientX, clientY, 0);
		const to = { x: p.x, y: p.y };
		if (this.eraseSegment(this.lastErase, to)) this.state.markErased();
		this.lastErase = to;
		this.eraserMoved = true;
	}

	private eraserRadiusPx(): number {
		const rect = this.canvas.getBoundingClientRect();
		return eraserRadiusFor(this.deps.toolState().width) * rect.height;
	}

	/** Cut away everything under the eraser between two normalized positions. */
	private eraseSegment(from: { x: number; y: number } | null, to: { x: number; y: number }): boolean {
		const key = this.canvas.getAttribute(OVERLAY_KEY_ATTR);
		if (!key) return false;
		const strokes = this.deps.strokes.forKey(key);
		if (strokes.length === 0) return false;
		const rect = this.canvas.getBoundingClientRect();
		const next = eraseAlongPath(strokes, from, to, this.eraserRadiusPx(), {
			width: rect.width,
			height: rect.height,
		});
		if (!next) return false;
		this.deps.strokes.setForKey(key, next);
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

	private showEraserCursor(clientX: number, clientY: number): void {
		const r = this.eraserRadiusPx();
		if (!this.eraserCursor) {
			this.eraserCursor = activeDocument.createElement('div');
			this.eraserCursor.className = 'jot-eraser-cursor';
			activeDocument.body.appendChild(this.eraserCursor);
		}
		const style = this.eraserCursor.style;
		style.width = `${2 * r}px`;
		style.height = `${2 * r}px`;
		style.transform = `translate(${clientX - r}px, ${clientY - r}px)`;
	}

	private hideEraserCursor(): void {
		this.eraserCursor?.remove();
		this.eraserCursor = null;
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
			this.eraseMoveTo(touch.clientX, touch.clientY);
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
		if (this.state.isErasing()) {
			this.finalizeEraserGesture();
		} else if (this.state.isDrawing()) {
			this.finalizeDrawingStroke();
			this.destroyDrawingPreview();
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

	/**
	 * Feed finger touches to the double-tap detector from Touch Events rather
	 * than Pointer Events: iPadOS starts its own pinch handling as soon as a
	 * second finger lands and disrupts the pointer stream, but touch events
	 * (including touchcancel) always arrive.
	 */
	private trackFingerTaps(): void {
		const each = (list: TouchList, fn: (touch: Touch) => void) => {
			for (let index = 0; index < list.length; index++) {
				const touch = list.item(index);
				if (!touch) continue;
				if ((touch as Touch & { touchType?: string }).touchType === 'stylus') continue;
				fn(touch);
			}
		};
		const opts = { passive: true };
		this.canvas.addEventListener(
			'touchstart',
			(e) =>
				each(e.changedTouches, (t) =>
					this.twoFingerTap.pointerDown(t.identifier, t.clientX, t.clientY),
				),
			opts,
		);
		this.canvas.addEventListener(
			'touchmove',
			(e) =>
				each(e.changedTouches, (t) =>
					this.twoFingerTap.pointerMove(t.identifier, t.clientX, t.clientY),
				),
			opts,
		);
		const lift = (e: TouchEvent) =>
			each(e.changedTouches, (t) => this.twoFingerTap.pointerUp(t.identifier));
		this.canvas.addEventListener('touchend', lift, opts);
		this.canvas.addEventListener('touchcancel', lift, opts);
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
