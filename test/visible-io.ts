/**
 * An IntersectionObserver that reports each target as visible once, as soon
 * as it is observed (a real browser reports the initial state right away;
 * happy-dom never does). Overlays only exist on pages near the viewport.
 */
export class VisibleIntersectionObserver {
	private seen = new Set<Element>();

	constructor(private callback: IntersectionObserverCallback) {}

	observe(target: Element): void {
		if (this.seen.has(target)) return;
		this.seen.add(target);
		this.callback(
			[{ target, isIntersecting: true } as unknown as IntersectionObserverEntry],
			this as unknown as IntersectionObserver,
		);
	}

	unobserve(): void {}

	disconnect(): void {}
}
