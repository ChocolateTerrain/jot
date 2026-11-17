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
		expect(document.querySelector('[data-tool="highlighter"]')?.textContent).toContain('Highlighter');
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

	it('embeds in the PDF top bar before its right-hand section', () => {
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
		const bar = document.createElement('div');
		bar.className = 'pdf-toolbar';
		const left = bar.appendChild(document.createElement('div'));
		const right = bar.appendChild(document.createElement('div'));
		document.body.appendChild(bar);

		toolbar.show(bar, 'inline', right);
		const dock = document.querySelector('.jot-docked-toolbar');
		expect(dock?.classList.contains('is-inline')).toBe(true);
		expect(dock?.previousElementSibling).toBe(left);
		expect(dock?.nextElementSibling).toBe(right);

		toolbar.show(bar, 'inline', right);
		expect(document.querySelectorAll('.jot-docked-toolbar')).toHaveLength(1);

		toolbar.show(document.body, 'floating');
		expect(bar.querySelector('.jot-docked-toolbar')).toBeNull();
		expect(document.querySelector('.jot-docked-toolbar')?.classList.contains('is-inline')).toBe(
			false,
		);
	});

	it('picks a color from the compact color pop-up', () => {
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
		toolbar.show(document.body, 'inline');

		document.querySelector<HTMLButtonElement>('.jot-dock-color-current')?.click();
		const popover = document.querySelector('.jot-dock-color-popover');
		expect(popover?.querySelectorAll('.jot-dock-color')).toHaveLength(7);
		popover?.querySelector<HTMLButtonElement>('[data-color="#d33333"]')?.click();

		expect(palette.getState().color).toBe('#d33333');
		expect(document.querySelector('.jot-dock-color-popover')).toBeNull();
		toolbar.hide();
	});
});
