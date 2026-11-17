import { setIcon } from 'obsidian';
import { OutsideCloseListener } from './outside-close-listener';
import {
	PALETTE_COLORS,
	PALETTE_WIDTHS,
	Palette,
	PaletteHooks,
	Tool,
} from './palette';

const TOOLS: { id: Tool; icon: string; label: string }[] = [
	{ id: 'pen', icon: 'pencil', label: 'Pen' },
	{ id: 'highlighter', icon: 'highlighter', label: 'Highlighter' },
	{ id: 'eraser', icon: 'eraser', label: 'Eraser' },
];

export type ToolbarPlacement = 'floating' | 'inline';

const MAX_WIDTH = PALETTE_WIDTHS[PALETTE_WIDTHS.length - 1] ?? 0.009;

export class DockedToolbar {
	private element: HTMLElement | null = null;
	private placement: ToolbarPlacement = 'floating';
	private popover: HTMLElement | null = null;
	private popoverClosedAt = 0;
	private outsideClose = new OutsideCloseListener(
		() => this.popover,
		() => this.closeColorPopover(),
	);

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
		this.closeColorPopover();
		this.element?.remove();
		this.element = null;
	}

	refresh(): void {
		if (this.element) this.render();
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
		toolbar.appendChild(
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
		toolbar.appendChild(
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

		for (const width of PALETTE_WIDTHS) {
			const button = doc.createElement('button');
			button.type = 'button';
			button.className = 'jot-dock-button jot-dock-width';
			button.dataset.width = String(width);
			button.setAttribute('aria-label', `Width ${width}`);
			button.setAttribute('aria-pressed', String(state.width === width));
			// An SVG circle, like the tool icons, so host button styles can't hide it.
			const size = Math.round(3 + (width / MAX_WIDTH) * 13);
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
		toolbar.appendChild(this.separator(doc));

		const colors = this.hooks.getColors?.() ?? PALETTE_COLORS;
		for (const color of colors) {
			const button = doc.createElement('button');
			button.type = 'button';
			button.className = 'jot-dock-button jot-dock-color';
			button.dataset.color = color;
			button.style.setProperty('background-color', color, 'important');
			button.setAttribute('aria-label', `Color ${color}`);
			button.setAttribute('aria-pressed', String(state.color === color));
			if (state.color === color) button.classList.add('is-active');
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
		current.style.setProperty('background-color', state.color, 'important');
		current.setAttribute('aria-label', 'Choose color');
		current.addEventListener('click', () => this.toggleColorPopover(current, colors));
		toolbar.appendChild(current);
		host.appendChild(toolbar);
	}

	private toggleColorPopover(anchor: HTMLElement, colors: readonly string[]): void {
		if (this.popover) {
			this.closeColorPopover();
			return;
		}
		// The outside-tap listener already closed it on this same tap.
		if (Date.now() - this.popoverClosedAt < 300) return;
		const doc = anchor.ownerDocument;
		const popover = doc.createElement('div');
		popover.className = 'jot-dock-color-popover';
		const rect = anchor.getBoundingClientRect();
		popover.style.top = `${Math.round(rect.bottom + 6)}px`;
		popover.style.right = `${Math.max(8, Math.round(doc.documentElement.clientWidth - rect.right))}px`;
		const selected = this.palette.getState().color;
		for (const color of colors) {
			const button = doc.createElement('button');
			button.type = 'button';
			button.className = 'jot-dock-button jot-dock-color';
			button.dataset.color = color;
			button.style.setProperty('background-color', color, 'important');
			button.setAttribute('aria-label', `Color ${color}`);
			if (color === selected) button.classList.add('is-active');
			button.addEventListener('click', () => {
				this.palette.setColor(color);
				this.closeColorPopover();
				this.refresh();
			});
			popover.appendChild(button);
		}
		doc.body.appendChild(popover);
		this.popover = popover;
		this.outsideClose.attach(doc);
	}

	private closeColorPopover(): void {
		if (!this.popover) return;
		this.outsideClose.detach();
		this.popover.remove();
		this.popover = null;
		this.popoverClosedAt = Date.now();
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