/* eslint-disable obsidianmd/prefer-active-doc */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockedToolbar } from '../src/docked-toolbar';
import { DEFAULT_TOOL_STATE, PALETTE_WIDTHS, Palette, Tool } from '../src/palette';
import { DEFAULT_TOOL_SIZES, sanitizeToolSizes } from '../src/settings-sizes';

afterEach(() => {
	document.body.innerHTML = '';
});

const SIZES: Record<Tool, number[]> = {
	pen: [0.001, 0.002, 0.003, 0.004],
	highlighter: [0.004, 0.006, 0.008, 0.01],
	eraser: [0.005, 0.01, 0.015, 0.02],
};

function setup() {
	const onChange = vi.fn();
	const hooks = {
		onUndo: vi.fn(),
		onRedo: vi.fn(),
		canUndo: () => false,
		canRedo: () => false,
		getWidths: (tool: Tool) => SIZES[tool],
	};
	const palette = new Palette({ ...DEFAULT_TOOL_STATE, tool: 'pen', width: 0.002 }, onChange, hooks);
	const toolbar = new DockedToolbar(palette, hooks);
	toolbar.show(document.body);
	return { palette, toolbar, onChange };
}

const shownWidths = () =>
	Array.from(document.querySelectorAll<HTMLElement>('.jot-dock-width')).map((b) =>
		Number(b.dataset.width),
	);

describe('per-tool size presets', () => {
	it('shows the size buttons of the selected tool', () => {
		const { palette, toolbar } = setup();
		expect(shownWidths()).toEqual(SIZES.pen);
		palette.setTool('highlighter');
		toolbar.refresh();
		expect(shownWidths()).toEqual(SIZES.highlighter);
		palette.setTool('eraser');
		toolbar.refresh();
		expect(shownWidths()).toEqual(SIZES.eraser);
	});

	it('keeps the same button selected when its size is edited', () => {
		const { palette } = setup();
		palette.replaceWidth('pen', 0.002, 0.0025);
		expect(palette.getState().width).toBe(0.0025);
		// Editing another tool's preset doesn't touch the current pen width.
		palette.replaceWidth('highlighter', 0.0025, 0.007);
		expect(palette.getState().width).toBe(0.0025);
	});

	it('updates a remembered eraser size', () => {
		const { palette } = setup();
		palette.setTool('eraser');
		palette.setWidth(0.01);
		palette.setTool('pen');
		palette.replaceWidth('eraser', 0.01, 0.012);
		palette.setTool('eraser');
		expect(palette.getState().width).toBe(0.012);
	});

	it('falls back to the built-in sizes without a hook', () => {
		const palette = new Palette({ ...DEFAULT_TOOL_STATE }, () => {}, {
			onUndo: vi.fn(),
			onRedo: vi.fn(),
			canUndo: () => false,
			canRedo: () => false,
		});
		expect(palette.widthsFor('pen')).toEqual(PALETTE_WIDTHS);
	});
});

describe('sanitizeToolSizes', () => {
	it('keeps valid saved sizes and repairs broken ones', () => {
		const result = sanitizeToolSizes({
			pen: [0.001, 0.002, 0.003, 0.004],
			highlighter: [0.001, 'x', 0.003, 0.004],
			eraser: [0.001],
		});
		expect(result.pen).toEqual([0.001, 0.002, 0.003, 0.004]);
		expect(result.highlighter).toEqual(DEFAULT_TOOL_SIZES.highlighter);
		expect(result.eraser).toEqual(DEFAULT_TOOL_SIZES.eraser);
	});

	it('uses defaults when nothing is saved', () => {
		expect(sanitizeToolSizes(undefined)).toEqual(DEFAULT_TOOL_SIZES);
	});
});
