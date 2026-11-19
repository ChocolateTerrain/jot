import { setIcon } from 'obsidian';
import { ToolbarPopover, fillColorGrid, fillSizeSlider } from './toolbar-popover';
import {
	PALETTE_COLORS,
	Palette,
	maxOf,
	PaletteHooks,
	Tool,
} from './palette';

const TOOLS: { id: Tool; icon: string; label: string }[] = [
	{ id: 'pen', icon: 'pencil', label: 'Pen' },
	{ id: 'highlighter', icon: 'highlighter', label: 'Highlighter' },
	{ id: 'eraser', icon: 'eraser', label: 'Eraser' },
];

export type ToolbarPlacement = 'floating' | 'inline';


export class DockedToolbar {
	private element: HTMLElement | null = null;
	private placement: ToolbarPlacement = 'floating';
	private popover = new ToolbarPopover();
	private undoButton: HTMLButtonElement | null = null;
	private redoButton: HTMLButtonElement | null = null;

	constructor(
		private palette: Palette,
		private hooks: PaletteHooks,
	) {}

	/**
	 * Show the toolbar in `parent`. 'floating' pins it to the bottom of the
	 * window; 'inline' embeds it in an existing bar (e.g. the PDF top bar),
	 * inserted before `before` when that is a child of `parent`.
	 */
	show(
		parent: HTMLElement,
		placement: ToolbarPlacement = 'floating',
		before: Element | null = null,
	): void {
		if (this.element?.parentElement === parent && this.placement === placement) return;
		this.hide();
		const element = parent.ownerDocument.createElement('div');
		element.className = 'jot-docked-toolbar';
		if (placement === 'inline') element.classList.add('is-inline');
		this.element = element;
		this.placement = placement;
		this.render();
		parent.insertBefore(element, before?.parentElement === parent ? before : null);
	}

	hide(): void {
		this.popover.close();
		this.element?.remove();
		this.element = null;
	}

	refresh(): void {
		if (this.element) this.render();
	}

	/**
	 * After a stroke only undo/redo availability changes; update just those
	 * two buttons instead of rebuilding the whole toolbar.
	 */
	refreshHistory(): void {
		if (this.undoButton) this.undoButton.disabled = !this.hooks.canUndo();
		if (this.redoButton) this.redoButton.disabled = !this.hooks.canRedo();
	}

	private render(): void {
		const host = this.element;
		if (!host) return;
		const doc = host.ownerDocument;
		host.replaceChildren();
		const toolbar = doc.createElement('div');
		toolbar.className = 'jot-docked-toolbar-controls';
		toolbar.setAttribute('role', 'toolbar');
		toolbar.setAttribute('aria-label', 'PDF annotation tools');
		this.undoButton = toolbar.appendChild(
			this.iconButton(
				doc,
				'undo-2',
				'Undo',
				() => {
					this.hooks.onUndo();
					this.refresh();
				},
				!this.hooks.canUndo(),
			),
		);
		this.redoButton = toolbar.appendChild(
			this.iconButton(
				doc,
				'redo-2',
				'Redo',
				() => {
					this.hooks.onRedo();
					this.refresh();
				},
				!this.hooks.canRedo(),
			),
		);
		toolbar.appendChild(this.separator(doc));

		const state = this.palette.getState();
		for (const tool of TOOLS) {
			const button = this.iconButton(doc, tool.icon, tool.label, () => {
				this.palette.setTool(tool.id);
				this.refresh();
			});
			button.classList.add('jot-dock-tool');
			const label = doc.createElement('span');
			label.className = 'jot-dock-tool-label';
			label.textContent = tool.label;
			button.appendChild(label);
			button.dataset.tool = tool.id;
			button.setAttribute('aria-pressed', String(state.tool === tool.id));
			if (state.tool === tool.id) button.classList.add('is-active');
			toolbar.appendChild(button);
		}
		toolbar.appendChild(this.separator(doc));

		const widths = this.palette.widthsFor(state.tool);
		const maxWidth = maxOf(widths);
		for (const width of widths) {
			const button = doc.createElement('button');
			button.type = 'button';
			button.className = 'jot-dock-button jot-dock-width';
			button.dataset.width = String(width);
			button.setAttribute('aria-label', `Width ${width}`);
			button.setAttribute('aria-pressed', String(state.width === width));
			// An SVG circle, like the tool icons, so host button styles can't hide it.
			const size = Math.round(3 + (Math.min(width, maxWidth) / maxWidth) * 13);
			const svgNs = 'http://www.w3.org/2000/svg';
			const dot = doc.createElementNS(svgNs, 'svg');
			dot.setAttribute('class', 'jot-dock-width-dot');
			dot.setAttribute('width', String(size));
			dot.setAttribute('height', String(size));
			dot.setAttribute('viewBox', '0 0 10 10');
			const circle = doc.createElementNS(svgNs, 'circle');
			circle.setAttribute('cx', '5');
			circle.setAttribute('cy', '5');
			circle.setAttribute('r', '5');
			circle.setAttribute('fill', 'currentColor');
			dot.style.setProperty('width', `${size}px`, 'important');
			dot.style.setProperty('height', `${size}px`, 'important');
			dot.appendChild(circle);
			button.appendChild(dot);
			button.addEventListener('click', () => {
				this.palette.setWidth(width);
				this.refresh();
			});
			if (state.width === width) button.classList.add('is-active');
			toolbar.appendChild(button);
		}
		const sizeMore = this.iconButton(doc, 'chevron-down', 'Adjust size', () =>
			this.toggleSizePopover(sizeMore),
		);
		sizeMore.classList.add('jot-dock-more');
		toolbar.appendChild(sizeMore);

		// Color doesn't apply to the eraser, so its controls are hidden then.
		if (state.tool !== 'eraser') {
			toolbar.appendChild(this.separator(doc));
			this.renderColors(doc, toolbar, state.color);
		}
		host.appendChild(toolbar);
	}

	private renderColors(doc: Document, toolbar: HTMLElement, selected: string): void {
		const colors = this.hooks.getColors?.() ?? PALETTE_COLORS;
		for (const color of colors) {
			const button = doc.createElement('button');
			button.type = 'button';
			button.className = 'jot-dock-button jot-dock-color';
			button.dataset.color = color;
			button.style.setProperty('background-color', color, 'important');
			button.setAttribute('aria-label', `Color ${color}`);
			button.setAttribute('aria-pressed', String(selected === color));
			if (selected === color) button.classList.add('is-active');
			button.addEventListener('click', () => {
				this.palette.setColor(color);
				this.refresh();
			});
			toolbar.appendChild(button);
		}

		// On narrow screens (iPad portrait) CSS hides the swatch row in the top
		// bar and shows this single "current color" button with a pop-up instead.
		const current = doc.createElement('button');
		current.type = 'button';
		current.className = 'jot-dock-button jot-dock-color jot-dock-color-current';
		current.style.setProperty('background-color', selected, 'important');
		current.setAttribute('aria-label', 'Choose color');
		current.addEventListener('click', () =>
			this.popover.toggle('color', current, 'jot-dock-color-popover', (popover) =>
				fillColorGrid(popover, colors, this.palette.getState().color, (color) => {
					this.palette.setColor(color);
					this.popover.close();
					this.refresh();
				}),
			),
		);
		toolbar.appendChild(current);
	}

	private toggleSizePopover(anchor: HTMLElement): void {
		this.popover.toggle('size', anchor, 'jot-dock-size-popover', (popover) => {
			const state = this.palette.getState();
			const presetIndex = this.palette.widthsFor(state.tool).indexOf(state.width);
			fillSizeSlider(popover, {
				tool: state.tool,
				presetIndex,
				width: state.width,
				color: state.color,
				onCommit: (width) => {
					if (presetIndex >= 0 && this.hooks.setWidthPreset) {
						// Changes that size button for good, same as in settings.
						void this.hooks.setWidthPreset(state.tool, presetIndex, width);
					} else {
						this.palette.setWidth(width);
					}
					this.refresh();
				},
			});
		});
	}

	private iconButton(
		doc: Document,
		icon: string,
		label: string,
		onClick: () => void,
		disabled = false,
	): HTMLButtonElement {
		const button = doc.createElement('button');
		button.type = 'button';
		button.className = 'jot-dock-button';
		button.setAttribute('aria-label', label);
		button.disabled = disabled;
		setIcon(button, icon);
		button.addEventListener('click', onClick);
		return button;
	}

	private separator(doc: Document): HTMLSpanElement {
		const separator = doc.createElement('span');
		separator.className = 'jot-dock-separator';
		return separator;
	}
}