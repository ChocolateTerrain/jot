/* eslint-disable obsidianmd/prefer-active-doc */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, TFile, WorkspaceLeaf } from 'obsidian';
import { DockedToolbar } from '../src/docked-toolbar';
import { HighlightLinkController } from '../src/highlight-link-controller';
import { buildHighlightLink, nativeSelectionParam } from '../src/highlight-link';
import type { OverlayManager } from '../src/overlay-manager';
import { DEFAULT_TOOL_STATE, Palette, Tool } from '../src/palette';
import {
	PointerEventHandler,
	type PointerEventHandlerDeps,
} from '../src/pointer-event-handler';
import type { Stroke } from '../src/stroke-math';
import { StrokeStore } from '../src/stroke-store';

beforeAll(() => {
	(window as { activeDocument?: Document }).activeDocument = document;
});
afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
	document.getSelection()?.removeAllRanges();
});

const hooks = { onUndo: vi.fn(), onRedo: vi.fn(), canUndo: () => false, canRedo: () => false };

describe('select tool', () => {
	it('is in the toolbar and hides sizes and colors', () => {
		const palette = new Palette({ ...DEFAULT_TOOL_STATE, tool: 'pen' }, () => {}, hooks);
		const toolbar = new DockedToolbar(palette, hooks);
		toolbar.show(document.body);
		document.querySelector<HTMLButtonElement>('[data-tool="select"]')!.click();
		expect(palette.getState().tool).toBe('select');
		expect(document.querySelectorAll('.jot-dock-width')).toHaveLength(0);
		expect(document.querySelectorAll('.jot-dock-color')).toHaveLength(0);
		expect(document.querySelector('.jot-dock-more')).toBeNull();
		toolbar.hide();
	});
});

function handlerWith(tool: Tool, onHighlightDrawn = vi.fn()) {
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
		setTransform: vi.fn(),
		clearRect: vi.fn(),
		beginPath: vi.fn(),
		moveTo: vi.fn(),
		lineTo: vi.fn(),
		stroke: vi.fn(),
	} as unknown as CanvasRenderingContext2D);
	const strokes = new StrokeStore();
	const deps = {
		palette: { isOpen: () => false, show: vi.fn() },
		strokes,
		overlays: { redrawPage: vi.fn() },
		sidecar: { scheduleSave: vi.fn() },
		undo: { push: vi.fn() },
		toolState: () => ({ tool, color: '#2e9e4f', width: 0.005 }),
		handedness: () => 'right',
		penHold: () => ({ enabled: false, durationMs: 300 }),
		onHighlightDrawn,
	} as unknown as PointerEventHandlerDeps;
	const canvas = document.body.appendChild(document.createElement('canvas'));
	canvas.setAttribute('data-jot-key', 'doc.pdf::1');
	canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 600, height: 800 }) as DOMRect;
	new PointerEventHandler(canvas, canvas.getContext('2d')!, deps).attach();
	const pen = (type: string, x: number, y = 300) =>
		canvas.dispatchEvent(
			new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 4, pointerType: 'pen', clientX: x, clientY: y, pressure: 0.5, buttons: 1 }),
		);
	const draw = () => {
		pen('pointerdown', 100);
		for (let x = 110; x <= 300; x += 10) pen('pointermove', x);
		pen('pointerup', 300);
	};
	return { strokes, draw, onHighlightDrawn, canvas };
}

describe('drawing with the select tool', () => {
	it('ignores the pencil so the PDF gets the input', () => {
		const { strokes, draw } = handlerWith('select');
		draw();
		expect(strokes.forKey('doc.pdf::1')).toHaveLength(0);
	});
});

describe('copy link offer after drawing', () => {
	it('offers a link where a highlight ends', () => {
		const { draw, onHighlightDrawn, canvas } = handlerWith('highlighter');
		draw();
		expect(onHighlightDrawn).toHaveBeenCalledOnce();
		const [overlay, stroke, x, y] = onHighlightDrawn.mock.calls[0] as [HTMLCanvasElement, Stroke, number, number];
		expect(overlay).toBe(canvas);
		expect(stroke.tool).toBe('highlighter');
		expect(x).toBeCloseTo(300, 0);
		expect(y).toBeCloseTo(300, 0);
	});

	it('does not offer one for pen strokes', () => {
		const { draw, onHighlightDrawn } = handlerWith('pen');
		draw();
		expect(onHighlightDrawn).not.toHaveBeenCalled();
	});
});

function pageWithText() {
	const page = document.body.appendChild(document.createElement('div'));
	page.className = 'page';
	const layer = page.appendChild(document.createElement('div'));
	layer.className = 'textLayer';
	const span = layer.appendChild(document.createElement('span'));
	span.textContent = 'Highlighted words here';
	const range = document.createRange();
	range.setStart(span.firstChild!, 0);
	range.setEnd(span.firstChild!, 11);
	return { page, span, range };
}

function leafWith(child: unknown): WorkspaceLeaf {
	return { view: { viewer: { child } } } as unknown as WorkspaceLeaf;
}

describe('nativeSelectionParam', () => {
	it("uses Obsidian's own selection description and restores the user's selection", () => {
		const { page, span, range } = pageWithText();
		const before = document.createRange();
		before.setStart(span.firstChild!, 12);
		before.setEnd(span.firstChild!, 17);
		document.getSelection()!.addRange(before);
		let seen = '';
		const child = {
			getTextSelectionRangeStr: vi.fn(() => {
				seen = document.getSelection()!.toString();
				return '4,0,4,11';
			}),
		};
		expect(nativeSelectionParam(leafWith(child), page, range)).toBe('4,0,4,11');
		expect(seen).toBe('Highlighted');
		expect(child.getTextSelectionRangeStr).toHaveBeenCalledWith(page);
		expect(document.getSelection()!.toString()).toBe('words');
	});

	it('returns null when this Obsidian version has no such function', () => {
		const { page, range } = pageWithText();
		expect(nativeSelectionParam(leafWith({}), page, range)).toBeNull();
		expect(nativeSelectionParam({ view: {} } as unknown as WorkspaceLeaf, page, range)).toBeNull();
	});

	it('returns null for anything that is not four numbers', () => {
		const { page, range } = pageWithText();
		const child = { getTextSelectionRangeStr: () => 'page=2' };
		expect(nativeSelectionParam(leafWith(child), page, range)).toBeNull();
	});
});

describe('buildHighlightLink', () => {
	it('falls back to a page link when there is no text under the highlight', () => {
		const page = document.body.appendChild(document.createElement('div'));
		const overlay = page.appendChild(document.createElement('canvas'));
		overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800 }) as DOMRect;
		const generateMarkdownLink = vi.fn(
			(_file: TFile, _src: string, subpath: string, alias: string) => `[[Paper.pdf${subpath}|${alias}]]`,
		);
		const app = { fileManager: { generateMarkdownLink } } as unknown as App;
		// A stand-in file; tests can't construct a real TFile.
		// eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
		const file = { basename: 'Paper', path: 'Paper.pdf' } as unknown as TFile;
		const stroke: Stroke = { tool: 'highlighter', color: '#ff0', width: 0.005, points: [{ x: 0.1, y: 0.1, pressure: 0.5 }, { x: 0.5, y: 0.1, pressure: 0.5 }] };
		const result = buildHighlightLink(app, leafWith({}), file, 7, page, overlay, stroke);
		expect(result.link).toBe('[[Paper.pdf#page=7|Paper, p.7]]');
		expect(result.text).toBe('');
	});
});

describe('tapping a highlight with the select tool', () => {
	function setup(tool: Tool) {
		const strokes = new StrokeStore();
		strokes.appendToKey('doc.pdf::1', {
			tool: 'highlighter',
			color: '#ff0',
			width: 0.005,
			points: [{ x: 0.1, y: 0.5, pressure: 0.5 }, { x: 0.6, y: 0.5, pressure: 0.5 }],
		});
		const page = document.body.appendChild(document.createElement('div'));
		page.className = 'page';
		const overlay = page.appendChild(document.createElement('canvas'));
		overlay.setAttribute('data-jot-key', 'doc.pdf::1');
		overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800 }) as DOMRect;
		const target = page.appendChild(document.createElement('span'));
		const controller = new HighlightLinkController(
			{} as App,
			strokes,
			{} as OverlayManager,
			() => tool,
		);
		const tap = (x: number, y: number) => {
			const event = new MouseEvent('click', { bubbles: true, clientX: x, clientY: y });
			Object.defineProperty(event, 'target', { value: target });
			controller.onClick(event);
		};
		return { tap, controller };
	}

	it('shows "Copy link" when tapping on a highlight', () => {
		const { tap, controller } = setup('select');
		tap(200, 400);
		expect(document.querySelector('.jot-link-chip')?.textContent).toContain('Copy link');
		controller.hide();
	});

	it('ignores taps next to the highlight, and taps with other tools', () => {
		setup('select').tap(200, 500);
		expect(document.querySelector('.jot-link-chip')).toBeNull();
		setup('pen').tap(200, 400);
		expect(document.querySelector('.jot-link-chip')).toBeNull();
	});
});
