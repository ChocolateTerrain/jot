/* eslint-disable obsidianmd/prefer-active-doc */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockedToolbar } from '../src/docked-toolbar';
import { DEFAULT_TOOL_STATE, DrawTool, PALETTE_WIDTHS, Palette, Tool } from '../src/palette';
import { DEFAULT_TOOL_SIZES, sanitizeToolSizes } from '../src/settings-sizes';

afterEach(() => {
	document.body.innerHTML = '';
});

const SIZES: Record<DrawTool, number[]> = {
	pen: [0.001, 0.002, 0.003],
	highlighter: [0.004, 0.006, 0.008],
	eraser: [0.005, 0.01, 0.015],
};

function setup() {
	const onChange = vi.fn();
	const hooks = {
		onUndo: vi.fn(),
		onRedo: vi.fn(),
		canUndo: () => false,
		canRedo: () => false,
		getWidths: (tool: DrawTool) => SIZES[tool],
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
			pen: [0.002, 0.003, 0.004],
			highlighter: [0.001, 'x', 0.003],
			eraser: [0.001],
		});
		expect(result.pen).toEqual([0.002, 0.003, 0.004]);
		expect(result.highlighter).toEqual(DEFAULT_TOOL_SIZES.highlighter);
		expect(result.eraser).toEqual(DEFAULT_TOOL_SIZES.eraser);
	});

	it('converts four saved sizes from older versions by dropping the thinnest', () => {
		const result = sanitizeToolSizes({ pen: [0.001, 0.002, 0.003, 0.004] });
		expect(result.pen).toEqual([0.002, 0.003, 0.004]);
	});

	it('has three sizes per tool by default', () => {
		expect(DEFAULT_TOOL_SIZES.pen).toHaveLength(3);
		expect(PALETTE_WIDTHS).toHaveLength(3);
	});

	it('uses defaults when nothing is saved', () => {
		expect(sanitizeToolSizes(undefined)).toEqual(DEFAULT_TOOL_SIZES);
	});
});

describe('toolbar size pop-up', () => {
	function open(state: { tool: Tool; width: number }) {
		const setWidthPreset = vi.fn();
		const hooks = {
			onUndo: vi.fn(),
			onRedo: vi.fn(),
			canUndo: () => false,
			canRedo: () => false,
			getWidths: (tool: DrawTool) => SIZES[tool],
			setWidthPreset,
		};
		const palette = new Palette({ ...DEFAULT_TOOL_STATE, ...state }, () => {}, hooks);
		const toolbar = new DockedToolbar(palette, hooks);
		toolbar.show(document.body, 'inline');
		document.querySelector<HTMLButtonElement>('.jot-dock-more')!.click();
		const popover = document.querySelector<HTMLElement>('.jot-dock-size-popover');
		const slider = popover?.querySelector<HTMLInputElement>('input[type="range"]') ?? null;
		return { palette, toolbar, popover, slider, setWidthPreset };
	}

	it('opens from the ▾ next to the sizes with the selected size', () => {
		const { popover, slider, toolbar } = open({ tool: 'highlighter', width: 0.006 });
		expect(popover?.textContent).toContain('Highlighter size 2');
		expect(slider?.value).toBe('6');
		toolbar.hide();
		expect(document.querySelector('.jot-dock-size-popover')).toBeNull();
	});

	it('updates the preview and value while dragging, and saves the preset on release', () => {
		const { popover, slider, setWidthPreset, toolbar } = open({ tool: 'pen', width: 0.003 });
		slider!.value = '7.5';
		slider!.dispatchEvent(new Event('input'));
		expect(popover!.querySelector('.jot-dock-size-value')?.textContent).toBe('7.5');
		expect(popover!.querySelector('line')?.getAttribute('stroke-width')).toBe(String(0.0075 * 1.15 * 400));
		expect(setWidthPreset).not.toHaveBeenCalled();
		slider!.dispatchEvent(new Event('change'));
		expect(setWidthPreset).toHaveBeenCalledWith('pen', 2, 0.0075);
		toolbar.hide();
	});

	it('shows an eraser circle preview', () => {
		const { popover, toolbar } = open({ tool: 'eraser', width: 0.01 });
		expect(popover!.querySelector('circle')).not.toBeNull();
		toolbar.hide();
	});

	it('just sets the width when the current size is not one of the buttons', () => {
		const { palette, slider, setWidthPreset, toolbar } = open({ tool: 'pen', width: 0.0033 });
		slider!.value = '5';
		slider!.dispatchEvent(new Event('change'));
		expect(setWidthPreset).not.toHaveBeenCalled();
		expect(palette.getState().width).toBe(0.005);
		toolbar.hide();
	});
});

describe('eraser hides color controls', () => {
	it('shows colors for pen and highlighter, hides them for the eraser', () => {
		const { palette, toolbar } = setup();
		const colorCount = () => document.querySelectorAll('.jot-docked-toolbar .jot-dock-color').length;
		expect(colorCount()).toBeGreaterThan(0);
		palette.setTool('eraser');
		toolbar.refresh();
		expect(colorCount()).toBe(0);
		expect(document.querySelectorAll('.jot-dock-width')).toHaveLength(3);
		palette.setTool('highlighter');
		toolbar.refresh();
		expect(colorCount()).toBeGreaterThan(0);
	});
});
