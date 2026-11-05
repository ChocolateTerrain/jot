import { setIcon } from 'obsidian';
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

const MAX_WIDTH = PALETTE_WIDTHS[PALETTE_WIDTHS.length - 1] ?? 0.009;

export class DockedToolbar {
	private element: HTMLElement | null = null;

	constructor(
		private palette: Palette,
		private hooks: PaletteHooks,
	) {}

	show(parent: HTMLElement): void {
		if (this.element?.parentElement === parent) return;
		this.hide();
		const element = parent.ownerDocument.createElement('div');
		element.className = 'jot-docked-toolbar';
		this.element = element;
		this.render();
		parent.appendChild(element);
	}

	hide(): void {
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
			const dot = doc.createElement('span');
			dot.className = 'jot-dock-width-dot';
			const size = Math.round(3 + (width / MAX_WIDTH) * 13);
			dot.style.width = `${size}px`;
			dot.style.height = `${size}px`;
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
			button.style.backgroundColor = color;
			button.setAttribute('aria-label', `Color ${color}`);
			button.setAttribute('aria-pressed', String(state.color === color));
			if (state.color === color) button.classList.add('is-active');
			button.addEventListener('click', () => {
				this.palette.setColor(color);
				this.refresh();
			});
			toolbar.appendChild(button);
		}
		host.appendChild(toolbar);
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