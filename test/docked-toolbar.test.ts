/* eslint-disable obsidianmd/prefer-active-doc */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockedToolbar } from '../src/docked-toolbar';
import { DEFAULT_TOOL_STATE, Palette } from '../src/palette';

afterEach(() => {
	document.body.innerHTML = '';
});

describe('DockedToolbar', () => {
	it('keeps tool, width, and color controls available after selection', () => {
		const palette = new Palette({ ...DEFAULT_TOOL_STATE }, () => {}, {
			onUndo: vi.fn(),
			onRedo: vi.fn(),
			canUndo: () => true,
			canRedo: () => true,
		});
		const toolbar = new DockedToolbar(palette, {
			onUndo: vi.fn(),
			onRedo: vi.fn(),
			canUndo: () => true,
			canRedo: () => true,
		});
		toolbar.show(document.body);

		document.querySelector<HTMLButtonElement>('[data-tool="highlighter"]')?.click();
		document.querySelector<HTMLButtonElement>('[data-width="0.005"]')?.click();
		document.querySelector<HTMLButtonElement>('[data-color="#d33333"]')?.click();

		expect(palette.getState()).toEqual({
			tool: 'highlighter',
			width: 0.005,
			color: '#d33333',
		});
		expect(document.querySelector('.jot-docked-toolbar')).not.toBeNull();
		expect(document.querySelector('[data-tool="highlighter"]')?.getAttribute('aria-pressed')).toBe('true');
	});

	it('removes the dock when hidden', () => {
		const palette = new Palette({ ...DEFAULT_TOOL_STATE }, () => {}, {
			onUndo: vi.fn(),
			onRedo: vi.fn(),
			canUndo: () => false,
			canRedo: () => false,
		});
		const toolbar = new DockedToolbar(palette, {
			onUndo: vi.fn(),
			onRedo: vi.fn(),
			canUndo: () => false,
			canRedo: () => false,
		});
		toolbar.show(document.body);
		toolbar.hide();
		expect(document.querySelector('.jot-docked-toolbar')).toBeNull();
	});
});