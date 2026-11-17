export interface TwoFingerTapOptions {
	/** Longest a single two-finger tap may last, from first finger down to last finger up. */
	maxTapMs: number;
	/** Longest gap between the end of the first tap and the end of the second. */
	maxGapMs: number;
	movementThresholdPx: number;
	now?: () => number;
}

interface TrackedTouch {
	downX: number;
	downY: number;
}

/**
 * Detects a two-finger double tap from touch pointer events. A tap is valid
 * when exactly two fingers touched, nothing moved, and it was quick enough to
 * not be confused with the two-finger hold that opens the palette.
 */
export class TwoFingerDoubleTapDetector {
	private touches = new Map<number, TrackedTouch>();
	private gestureStart = 0;
	private maxTouches = 0;
	private moved = false;
	private lastTapAt: number | null = null;
	private now: () => number;

	constructor(
		private options: TwoFingerTapOptions,
		private onDoubleTap: () => void,
	) {
		this.now = options.now ?? (() => Date.now());
	}

	pointerDown(id: number, x: number, y: number): void {
		if (this.touches.size === 0) {
			this.gestureStart = this.now();
			this.maxTouches = 0;
			this.moved = false;
		}
		this.touches.set(id, { downX: x, downY: y });
		this.maxTouches = Math.max(this.maxTouches, this.touches.size);
	}

	pointerMove(id: number, x: number, y: number): void {
		const touch = this.touches.get(id);
		if (!touch) return;
		const dx = x - touch.downX;
		const dy = y - touch.downY;
		if (dx * dx + dy * dy > this.options.movementThresholdPx ** 2) this.moved = true;
	}

	pointerUp(id: number): void {
		if (!this.touches.delete(id) || this.touches.size > 0) return;
		const now = this.now();
		const isTap =
			this.maxTouches === 2 && !this.moved && now - this.gestureStart <= this.options.maxTapMs;
		if (!isTap) {
			this.lastTapAt = null;
			return;
		}
		if (this.lastTapAt !== null && now - this.lastTapAt <= this.options.maxGapMs) {
			this.lastTapAt = null;
			this.onDoubleTap();
			return;
		}
		this.lastTapAt = now;
	}
}
