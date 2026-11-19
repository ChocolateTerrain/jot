/* eslint-disable obsidianmd/prefer-active-doc */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { OverlayManager } from '../src/overlay-manager';
import { StrokeStore } from '../src/stroke-store';

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
