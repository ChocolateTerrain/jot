/* eslint-disable obsidianmd/prefer-active-doc */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { OverlayManager } from '../src/overlay-manager';
import { StrokeStore } from '../src/stroke-store';

function pdfLeafWithPages(pageCount: number) {
	const containerEl = document.createElement('div');
	for (let n = 1; n <= pageCount; n++) {
		const page = document.createElement('div');
		page.className = 'page';
		page.setAttribute('data-page-number', String(n));
		containerEl.appendChild(page);
	}
	document.body.appendChild(containerEl);
	return { view: { getViewType: () => 'pdf', file: { path: 'doc.pdf' }, containerEl } };
}

function appWith(leaf: ReturnType<typeof pdfLeafWithPages>): App {
	return {
		workspace: {
			getMostRecentLeaf: () => leaf,
			iterateAllLeaves: (cb: (l: unknown) => void) => cb(leaf),
		},
	} as unknown as App;
}

beforeAll(() => {
	(window as { activeDocument?: Document }).activeDocument = document;
});

afterEach(() => {
	document.body.innerHTML = '';
	vi.unstubAllGlobals();
});

describe('OverlayManager plugin reload', () => {
	it('removes its overlay canvases when detached', () => {
		const leaf = pdfLeafWithPages(2);
		const manager = new OverlayManager(appWith(leaf), new StrokeStore(), () => {});
		manager.attachToActivePdf();
		expect(leaf.view.containerEl.querySelectorAll('canvas.jot-overlay-canvas')).toHaveLength(2);

		manager.detachAll();

		expect(leaf.view.containerEl.querySelectorAll('canvas.jot-overlay-canvas')).toHaveLength(0);
	});

	// Overlays left behind by a previous plugin instance keep that instance's
	// pointer listeners — and with them its settings — until Obsidian restarts.
	it('lets a fresh instance wire every page after the previous one detached', () => {
		const leaf = pdfLeafWithPages(2);
		const first = new OverlayManager(appWith(leaf), new StrokeStore(), () => {});
		first.attachToActivePdf();
		first.detachAll();

		const wired: HTMLCanvasElement[] = [];
		const second = new OverlayManager(appWith(leaf), new StrokeStore(), (c) => wired.push(c));
		second.attachToActivePdf();

		expect(wired).toHaveLength(2);
		expect(leaf.view.containerEl.querySelectorAll('canvas.jot-overlay-canvas')).toHaveLength(2);
	});

	it('replaces overlays a 1.0.8 instance left behind and hides ours from its observers', () => {
		const leaf = pdfLeafWithPages(2);
		leaf.view.containerEl.querySelectorAll<HTMLElement>('.page').forEach((page, i) => {
			const stale = document.createElement('canvas');
			stale.className = 'jot-overlay';
			stale.setAttribute('data-jot-key', `doc.pdf#${i + 1}`);
			page.appendChild(stale);
			page.setAttribute('data-jot-observed', '1');
		});

		const wired: HTMLCanvasElement[] = [];
		new OverlayManager(appWith(leaf), new StrokeStore(), (c) => wired.push(c)).attachToActivePdf();

		expect(wired).toHaveLength(2);
		// 1.0.8's leftover observers find overlays with this selector.
		expect(leaf.view.containerEl.querySelectorAll('canvas.jot-overlay')).toHaveLength(0);
		expect(leaf.view.containerEl.querySelectorAll('canvas.jot-overlay-canvas')).toHaveLength(2);
	});

	it('keeps its own overlay when re-attaching to the same page', () => {
		const leaf = pdfLeafWithPages(1);
		const wired: HTMLCanvasElement[] = [];
		const manager = new OverlayManager(appWith(leaf), new StrokeStore(), (c) => wired.push(c));
		manager.attachToActivePdf();
		manager.attachToActivePdf();

		expect(wired).toHaveLength(1);
	});

	it('allocates backing stores only while pages are near the viewport', () => {
		let visibilityCallback!: IntersectionObserverCallback;
		class FakeIntersectionObserver {
			constructor(callback: IntersectionObserverCallback) {
				visibilityCallback = callback;
			}
			observe() {}
			disconnect() {}
		}
		vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

		const leaf = pdfLeafWithPages(3);
		const pages: HTMLElement[] = [];
		leaf.view.containerEl
			.querySelectorAll<HTMLElement>('.page')
			.forEach((page) => pages.push(page));
		for (const page of pages) {
			page.getBoundingClientRect = () => ({ width: 800, height: 1000 }) as DOMRect;
		}
		const manager = new OverlayManager(appWith(leaf), new StrokeStore(), () => {});
		manager.attachToActivePdf();

		const canvases: HTMLCanvasElement[] = [];
		leaf.view.containerEl
			.querySelectorAll<HTMLCanvasElement>('canvas.jot-overlay-canvas')
			.forEach((canvas) => canvases.push(canvas));
		expect(canvases.map((canvas) => canvas.width * canvas.height)).toEqual([0, 0, 0]);

		visibilityCallback(
			[
				{ target: pages[0]!, isIntersecting: true } as unknown as IntersectionObserverEntry,
			],
			{} as IntersectionObserver,
		);
		expect(canvases[0]!.width * canvases[0]!.height).toBe(800_000);

		visibilityCallback(
			[
				{ target: pages[0]!, isIntersecting: false } as unknown as IntersectionObserverEntry,
			],
			{} as IntersectionObserver,
		);
		expect(canvases[0]!.width * canvases[0]!.height).toBe(0);
	});

	it('aligns the overlay to the PDF canvas wrapper inside the page', () => {
		const leaf = pdfLeafWithPages(1);
		const page = leaf.view.containerEl.querySelector<HTMLElement>('.page')!;
		page.getBoundingClientRect = () =>
			({ left: 0, top: 0, width: 800, height: 1000 }) as DOMRect;
		const wrapper = document.createElement('div');
		wrapper.className = 'canvasWrapper';
		wrapper.getBoundingClientRect = () =>
			({ left: 8, top: 36, width: 784, height: 928 }) as DOMRect;
		const pdfCanvas = document.createElement('canvas');
		pdfCanvas.getBoundingClientRect = () =>
			({ left: 8, top: 48, width: 784, height: 928 }) as DOMRect;
		wrapper.appendChild(pdfCanvas);
		page.appendChild(wrapper);

		new OverlayManager(appWith(leaf), new StrokeStore(), () => {}).attachToActivePdf();

		const overlay = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay-canvas')!;
		expect(overlay.parentElement).toBe(wrapper);
		expect(overlay.style.top).toBe('12px');
		expect(overlay.style.width).toBe('784px');
		expect(overlay.style.height).toBe('928px');
	});

	it('converts the PDF canvas rect to local CSS units when its wrapper is scaled', () => {
		const leaf = pdfLeafWithPages(1);
		const page = leaf.view.containerEl.querySelector<HTMLElement>('.page')!;
		page.getBoundingClientRect = () =>
			({ left: 0, top: 0, width: 1600, height: 2000 }) as DOMRect;
		const wrapper = document.createElement('div');
		wrapper.className = 'canvasWrapper';
		Object.defineProperty(wrapper, 'offsetWidth', { value: 784 });
		Object.defineProperty(wrapper, 'offsetHeight', { value: 928 });
		wrapper.getBoundingClientRect = () =>
			({ left: 8, top: 36, width: 1568, height: 1856 }) as DOMRect;
		const pdfCanvas = document.createElement('canvas');
		pdfCanvas.getBoundingClientRect = () =>
			({ left: 28, top: 60, width: 1520, height: 1760 }) as DOMRect;
		wrapper.appendChild(pdfCanvas);
		page.appendChild(wrapper);

		new OverlayManager(appWith(leaf), new StrokeStore(), () => {}).attachToActivePdf();

		const overlay = page.querySelector<HTMLCanvasElement>('canvas.jot-overlay-canvas')!;
		expect(overlay.style.left).toBe('10px');
		expect(overlay.style.top).toBe('12px');
		expect(overlay.style.width).toBe('760px');
		expect(overlay.style.height).toBe('880px');
	});
});
