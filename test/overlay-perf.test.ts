/* eslint-disable obsidianmd/prefer-active-doc */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { OverlayManager } from '../src/overlay-manager';
import { StrokeStore } from '../src/stroke-store';
import { VisibleIntersectionObserver } from './visible-io';

// Large-PDF behaviour: Obsidian's PDF viewer keeps rewriting text layers while
// you scroll. That must not make the plugin re-measure or redraw every page.

function bigPdf(pageCount: number) {
	const containerEl = document.createElement('div');
	for (let n = 1; n <= pageCount; n++) {
		const page = document.createElement('div');
		page.className = 'page';
		page.setAttribute('data-page-number', String(n));
		const wrapper = page.appendChild(document.createElement('div'));
		wrapper.className = 'canvasWrapper';
		const text = page.appendChild(document.createElement('div'));
		text.className = 'textLayer';
		containerEl.appendChild(page);
	}
	document.body.appendChild(containerEl);
	const leaf = { view: { getViewType: () => 'pdf', file: { path: 'big.pdf' }, containerEl } };
	const app = {
		workspace: {
			getMostRecentLeaf: () => leaf,
			iterateAllLeaves: (cb: (l: unknown) => void) => cb(leaf),
		},
	} as unknown as App;
	return { leaf, app, containerEl };
}

const flush = async () => {
	await new Promise((r) => window.setTimeout(r, 0));
	await new Promise((r) => window.requestAnimationFrame(() => r(null)));
	await new Promise((r) => window.setTimeout(r, 0));
};

beforeAll(() => {
	(window as { activeDocument?: Document }).activeDocument = document;
	vi.stubGlobal('IntersectionObserver', VisibleIntersectionObserver);
});
afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

describe('OverlayManager with a large PDF', () => {
	it('does not re-measure or redraw all pages when text layers update', async () => {
		const { app, containerEl } = bigPdf(300);
		const manager = new OverlayManager(app, new StrokeStore(), () => {});
		manager.attachToActivePdf();
		await flush();

		const rects = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
		const styles = vi.spyOn(window, 'getComputedStyle');
		const redraws = vi.spyOn(manager, 'redrawPage');

		// 20 rounds of the viewer filling in text layers while scrolling.
		const layers = containerEl.querySelectorAll<HTMLElement>('.textLayer');
		for (let round = 0; round < 20; round++) {
			for (let i = round * 3; i < round * 3 + 3; i++) {
				const span = document.createElement('span');
				span.textContent = 'Word';
				layers[i]!.appendChild(span);
			}
			await flush();
		}

		const layoutReads = rects.mock.calls.length + styles.mock.calls.length;
		// Before the fix this was 6000 of each (every page, every update).
		expect(layoutReads).toBe(0);
		expect(redraws.mock.calls.length).toBe(0);
		manager.detachAll();
	});

	it('still adds overlays when the viewer adds new pages', async () => {
		const { app, containerEl } = bigPdf(3);
		const manager = new OverlayManager(app, new StrokeStore(), () => {});
		manager.attachToActivePdf();
		const page = document.createElement('div');
		page.className = 'page';
		page.setAttribute('data-page-number', '4');
		containerEl.appendChild(page);
		await flush();
		expect(containerEl.querySelectorAll('canvas.jot-overlay-canvas')).toHaveLength(4);
		manager.detachAll();
	});

	it('re-attaches an overlay when the viewer re-renders a page', async () => {
		const { app, containerEl } = bigPdf(2);
		const manager = new OverlayManager(app, new StrokeStore(), () => {});
		manager.attachToActivePdf();
		const page = containerEl.querySelector<HTMLElement>('.page')!;
		// The viewer swaps the canvas wrapper, dropping our overlay with it.
		page.querySelector('.canvasWrapper')!.remove();
		const fresh = page.appendChild(document.createElement('div'));
		fresh.className = 'canvasWrapper';
		await flush();
		expect(fresh.querySelector('canvas.jot-overlay-canvas')).not.toBeNull();
		manager.detachAll();
	});
});

describe('erasing on a page full of ink', () => {
	function canvasWithMockContext() {
		const ctx = {
			setTransform: vi.fn(),
			clearRect: vi.fn(),
			save: vi.fn(),
			restore: vi.fn(),
			beginPath: vi.fn(),
			rect: vi.fn(),
			clip: vi.fn(),
			moveTo: vi.fn(),
			lineTo: vi.fn(),
			stroke: vi.fn(),
		};
		const canvas = document.createElement('canvas');
		canvas.width = 1200;
		canvas.height = 1600;
		// Fixture: the page's CSS size, which redrawPage reads back.
		// eslint-disable-next-line obsidianmd/no-static-styles-assignment
		canvas.setAttribute('style', 'width: 600px; height: 800px');
		canvas.setAttribute('data-jot-key', 'big.pdf::1');
		canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
		return { canvas, ctx };
	}

	it('redraws only strokes near the erased area', () => {
		const { app } = bigPdf(1);
		const strokes = new StrokeStore();
		const line = (y: number) => ({
			tool: 'pen' as const,
			color: '#000',
			width: 0.0025,
			points: [
				{ x: 0.1, y, pressure: 0.5 },
				{ x: 0.9, y, pressure: 0.5 },
			],
		});
		for (let i = 0; i < 20; i++) strokes.appendToKey('big.pdf::1', line(0.04 + i * 0.045));
		const manager = new OverlayManager(app, strokes, () => {});
		const { canvas, ctx } = canvasWithMockContext();

		manager.redrawPage(canvas, { minX: 0.4, minY: 0.03, maxX: 0.5, maxY: 0.05 });
		expect(ctx.clip).toHaveBeenCalledOnce();
		expect(ctx.stroke).toHaveBeenCalledTimes(1);

		ctx.stroke.mockClear();
		manager.redrawPage(canvas);
		expect(ctx.stroke).toHaveBeenCalledTimes(20);
	});
});

describe('select tool on iPad', () => {
	it('keeps page touches from reaching the sidebar swipe gesture', () => {
		const { app, containerEl } = bigPdf(1);
		const manager = new OverlayManager(app, new StrokeStore(), () => {});
		manager.attachToActivePdf();
		const reachedApp = vi.fn();
		document.addEventListener('touchstart', reachedApp);
		const touchOn = (el: Element) => el.dispatchEvent(new Event('touchstart', { bubbles: true }));
		const text = containerEl.querySelector('.textLayer')!;

		touchOn(text);
		expect(reachedApp).toHaveBeenCalledTimes(1);

		document.body.classList.add('jot-select-mode');
		touchOn(text);
		expect(reachedApp).toHaveBeenCalledTimes(1);
		// Outside the pages (e.g. the toolbar), swipes still work.
		touchOn(containerEl);
		expect(reachedApp).toHaveBeenCalledTimes(2);

		manager.detachAll();
		touchOn(text);
		expect(reachedApp).toHaveBeenCalledTimes(3);
		document.body.classList.remove('jot-select-mode');
		document.removeEventListener('touchstart', reachedApp);
	});
});

describe('a 900-page PDF', () => {
	it('only has canvases and per-page observers for pages near the viewport', () => {
		let report!: IntersectionObserverCallback;
		const observed: Element[] = [];
		class FakeIntersectionObserver {
			constructor(callback: IntersectionObserverCallback) {
				report = callback;
			}
			observe(target: Element) {
				observed.push(target);
			}
			disconnect() {}
		}
		vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
		let resizeObservers = 0;
		class CountingResizeObserver {
			constructor() {
				resizeObservers++;
			}
			observe() {}
			disconnect() {}
		}
		vi.stubGlobal('ResizeObserver', CountingResizeObserver);
		const { app, containerEl } = bigPdf(900);
		const manager = new OverlayManager(app, new StrokeStore(), () => {});
		manager.attachToActivePdf();
		const pages = containerEl.querySelectorAll<HTMLElement>('.page');
		// The browser reports the three pages on screen as visible.
		report(
			[0, 1, 2].map((i) => ({ target: pages[i]!, isIntersecting: true }) as unknown as IntersectionObserverEntry),
			{} as IntersectionObserver,
		);
		// One visibility check per page (a repeat observe of the same page is a no-op).
		expect(new Set(observed).size).toBe(900);
		expect(containerEl.querySelectorAll('canvas.jot-overlay-canvas')).toHaveLength(3);
		expect(resizeObservers).toBe(3);
		manager.detachAll();
		vi.unstubAllGlobals();
		vi.stubGlobal('IntersectionObserver', VisibleIntersectionObserver);
	});
});
