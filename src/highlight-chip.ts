import { setIcon } from 'obsidian';
import { OutsideCloseListener } from './outside-close-listener';

const CHIP_CLASS = 'jot-link-chip';
const VISIBLE_MS = 4000;

/**
 * A small "Copy link" button shown next to a highlight: briefly after drawing
 * one, or when tapping one with the select tool. Only one exists at a time.
 */
export class HighlightLinkChip {
	private element: HTMLElement | null = null;
	private timer: number | null = null;
	private outsideClose = new OutsideCloseListener(
		() => this.element,
		() => this.hide(),
	);

	show(doc: Document, clientX: number, clientY: number, onCopy: () => void): void {
		this.hide();
		const chip = doc.createElement('button');
		chip.type = 'button';
		chip.className = CHIP_CLASS;
		const icon = chip.appendChild(doc.createElement('span'));
		icon.className = 'jot-link-chip-icon';
		setIcon(icon, 'link');
		chip.appendChild(doc.createTextNode('Copy link'));
		chip.setAttribute('aria-label', 'Copy link to this highlight');
		// Just above the end of the highlight, kept on screen.
		const width = doc.documentElement.clientWidth || 1000;
		chip.style.left = `${Math.max(8, Math.min(width - 120, clientX - 50))}px`;
		chip.style.top = `${Math.max(8, clientY - 52)}px`;
		chip.addEventListener('click', (e) => {
			e.stopPropagation();
			onCopy();
			this.hide();
		});
		doc.body.appendChild(chip);
		this.element = chip;
		this.outsideClose.attach(doc);
		this.timer = window.setTimeout(() => this.hide(), VISIBLE_MS);
	}

	hide(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.outsideClose.detach();
		this.element?.remove();
		this.element = null;
	}

	isShown(): boolean {
		return this.element !== null;
	}
}
