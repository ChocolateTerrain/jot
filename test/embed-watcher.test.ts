/* eslint-disable obsidianmd/prefer-active-doc */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { EmbedWatcher } from '../src/embed-watcher';
import { OverlayManager } from '../src/overlay-manager';
import { StrokeStore } from '../src/stroke-store';
import { VisibleIntersectionObserver } from './visible-io';

beforeAll(() => {
	(window as { activeDocument?: Document }).activeDocument = document;
	vi.stubGlobal('IntersectionObserver', VisibleIntersectionObserver);
});

let watcher: EmbedWatcher | null = null;
afterEach(() => {
	watcher?.stop();
	watcher = null;
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

const frame = async () => {
	await new Promise((r) => window.setTimeout(r, 0));
	await new Promise((r) => window.requestAnimationFrame(() => r(null)));
	await new Promise((r) => window.setTimeout(r, 0));
};

type FakeLeaf = { view: { getViewType: () => string; containerEl: HTMLElement; file?: unknown } };
const tabs: FakeLeaf[] = [];
let mostRecent: FakeLeaf | null = null;

function setup() {
	tabs.length = 0;
	mostRecent = null;
	const strokes = new StrokeStore();
	strokes.appendToKey('Books/Turbulent.pdf::205', {
		tool: 'highlighter',
		color: '#2e9e4f',
		width: 0.005,
		points: [
			{ x: 0.1, y: 0.5, pressure: 0.5 },
			{ x: 0.6, y: 0.5, pressure: 0.5 },
		],
	});
	const app = {
		workspace: {
			getMostRecentLeaf: () => mostRecent,
			iterateAllLeaves: (cb: (leaf: unknown) => void) => tabs.forEach(cb),
		},
		metadataCache: {
			getFirstLinkpathDest: (path: string) =>
				path === 'Turbulent.pdf' || path === 'Turbulent'
					? { path: 'Books/Turbulent.pdf', extension: 'pdf' }
					: null,
		},
	} as unknown as App;
	const overlays = new OverlayManager(app, strokes, () => {});
	const loadIfNeeded = vi.fn(async () => {});
	watcher = new EmbedWatcher(app, overlays, strokes, loadIfNeeded);
	watcher.start(document);
	return { watcher, loadIfNeeded, overlays };
}

function pdfPage(pageNumber: number): HTMLElement {
	const page = document.createElement('div');
	page.className = 'page';
	page.setAttribute('data-page-number', String(pageNumber));
	page.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800 }) as DOMRect;
	page.appendChild(document.createElement('div')).className = 'textLayer';
	return page;
}

describe('annotations in embeds and hover previews', () => {
	it('adds a read-only overlay to a PDF embed in a note', async () => {
		const { loadIfNeeded } = setup();
		const embed = document.body.appendChild(document.createElement('div'));
		embed.className = 'internal-embed pdf-embed';
		embed.setAttribute('src', 'Turbulent.pdf#page=205&selection=1,0,2,5');
		embed.appendChild(pdfPage(205));
		await frame();
		const overlay = embed.querySelector('canvas.jot-overlay-canvas');
		expect(overlay?.classList.contains('jot-readonly')).toBe(true);
		expect(overlay?.getAttribute('data-jot-key')).toBe('Books/Turbulent.pdf::205');
		expect(loadIfNeeded).toHaveBeenCalledWith('Books/Turbulent.pdf');
	});

	it('uses the hovered link for a hover preview without a src', async () => {
		const { watcher } = setup();
		watcher.noteHover('Turbulent#page=205', 'Notes/IAHR.md');
		const popover = document.body.appendChild(document.createElement('div'));
		popover.className = 'popover hover-popover';
		popover.appendChild(pdfPage(205));
		await frame();
		expect(popover.querySelector('canvas.jot-readonly')).not.toBeNull();
	});

	it('leaves the managed PDF tab to the main overlay logic (editable overlays)', async () => {
		const { overlays } = setup();
		const tab = document.body.appendChild(document.createElement('div'));
		const leaf: FakeLeaf = {
			view: { getViewType: () => 'pdf', containerEl: tab, file: { path: 'Books/Turbulent.pdf', extension: 'pdf' } },
		};
		tabs.push(leaf);
		mostRecent = leaf;
		tab.appendChild(pdfPage(1));
		overlays.attachToActivePdf();
		await frame();
		const overlay = tab.querySelector('canvas.jot-overlay-canvas');
		expect(overlay).not.toBeNull();
		expect(overlay?.classList.contains('jot-readonly')).toBe(false);
	});

	it('shows a not-yet-active PDF tab read-only, then makes it editable when it becomes active', async () => {
		const { overlays } = setup();
		const tab = document.body.appendChild(document.createElement('div'));
		const leaf: FakeLeaf = {
			view: { getViewType: () => 'pdf', containerEl: tab, file: { path: 'Books/Turbulent.pdf', extension: 'pdf' } },
		};
		tabs.push(leaf);
		tab.appendChild(pdfPage(205));
		await frame();
		expect(tab.querySelector('canvas.jot-readonly')).not.toBeNull();
		mostRecent = leaf;
		overlays.attachToActivePdf();
		expect(tab.querySelector('canvas.jot-readonly')).toBeNull();
		expect(tab.querySelectorAll('canvas.jot-overlay-canvas')).toHaveLength(1);
	});

	it('finds preview pages it missed by scanning after a hover', async () => {
		const { watcher } = setup();
		watcher.stop();
		const popover = document.body.appendChild(document.createElement('div'));
		popover.className = 'popover hover-popover';
		popover.appendChild(pdfPage(205));
		watcher.noteHover('Turbulent#page=205', 'Notes/IAHR.md');
		await new Promise((r) => window.setTimeout(r, 350));
		await frame();
		expect(popover.querySelector('canvas.jot-readonly')).not.toBeNull();
		expect(watcher.debugReport()).toContain('1 pages outside the managed PDF tab');
	});

	it('treats a PDF view inside a hover preview as a preview, using its file', async () => {
		setup();
		const popover = document.body.appendChild(document.createElement('div'));
		popover.className = 'popover hover-popover';
		const view = popover.appendChild(document.createElement('div'));
		tabs.push({
			view: {
				getViewType: () => 'pdf',
				containerEl: view,
				file: { path: 'Books/Turbulent.pdf', extension: 'pdf' },
			},
		});
		view.appendChild(pdfPage(205));
		await frame();
		const overlay = view.querySelector('canvas.jot-readonly');
		expect(overlay?.getAttribute('data-jot-key')).toBe('Books/Turbulent.pdf::205');
	});
});

describe("Obsidian's link tint over a highlight", () => {
	async function tintAt(y: number) {
		setup();
		const embed = document.body.appendChild(document.createElement('div'));
		embed.setAttribute('src', 'Turbulent.pdf#page=205');
		const page = embed.appendChild(pdfPage(205));
		await frame();
		const overlay = page.querySelector<HTMLCanvasElement>('canvas')!;
		overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800 }) as DOMRect;
		const span = page.querySelector('.textLayer')!.appendChild(document.createElement('span'));
		span.getBoundingClientRect = () => ({ left: 100, top: y - 8, width: 200, height: 16 }) as DOMRect;
		span.classList.add('mod-focused');
		await frame();
		return span;
	}

	it('is made see-through where it covers one of our highlights', async () => {
		const span = await tintAt(400);
		expect(span.classList.contains('jot-tint-hidden')).toBe(true);
	});

	it('is left alone elsewhere', async () => {
		const span = await tintAt(600);
		expect(span.classList.contains('jot-tint-hidden')).toBe(false);
	});
});

describe('preview debug info', () => {
	it('reports decisions and where each page sits', async () => {
		const { watcher } = setup();
		const embed = document.body.appendChild(document.createElement('div'));
		embed.className = 'internal-embed pdf-embed';
		embed.setAttribute('src', 'Turbulent.pdf#page=205');
		embed.appendChild(pdfPage(205));
		await frame();
		const report = watcher.debugReport();
		expect(report).toContain('read-only overlay for Books/Turbulent.pdf');
		expect(report).toContain('div.internal-embed.pdf-embed[src="Turbulent.pdf#page=205"]');
		expect(report).toContain('page 205: overlay=jot-overlay-canvas jot-readonly');
		expect(report).toContain('Watcher: running');
	});
});
