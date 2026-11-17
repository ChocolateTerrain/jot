import { OutsideCloseListener } from './outside-close-listener';
import type { Tool } from './palette';
import { eraserRadiusFor } from './stroke-erase';
import { HIGHLIGHTER_ALPHA, HIGHLIGHTER_WIDTH_FACTOR } from './stroke-render';

/**
 * One pop-up at a time, anchored to a toolbar button: opens below the button
 * when the toolbar is at the top of the screen, above it when at the bottom.
 */
export class ToolbarPopover {
	private element: HTMLElement | null = null;
	private kind: string | null = null;
	private closedKind: string | null = null;
	private closedAt = 0;
	private outsideClose = new OutsideCloseListener(
		() => this.element,
		() => this.close(),
	);

	toggle(kind: string, anchor: HTMLElement, className: string, fill: (popover: HTMLElement) => void): void {
		if (this.element) {
			const wasSame = this.kind === kind;
			this.close();
			if (wasSame) return;
		}
		// Tapping the same button: the outside-tap listener already closed it.
		if (this.closedKind === kind && Date.now() - this.closedAt < 300) return;
		const doc = anchor.ownerDocument;
		const popover = doc.createElement('div');
		popover.className = `jot-dock-popover ${className}`;
		const rect = anchor.getBoundingClientRect();
		const viewportWidth = doc.documentElement.clientWidth;
		const viewportHeight = doc.documentElement.clientHeight || rect.bottom * 2;
		if (rect.top < viewportHeight / 2) {
			popover.style.top = `${Math.round(rect.bottom + 6)}px`;
		} else {
			popover.style.bottom = `${Math.round(viewportHeight - rect.top + 6)}px`;
		}
		popover.style.right = `${Math.max(8, Math.round(viewportWidth - rect.right))}px`;
		fill(popover);
		doc.body.appendChild(popover);
		this.element = popover;
		this.kind = kind;
		this.outsideClose.attach(doc);
	}

	close(): void {
		if (!this.element) return;
		this.outsideClose.detach();
		this.element.remove();
		this.closedKind = this.kind;
		this.closedAt = Date.now();
		this.element = null;
		this.kind = null;
	}
}

export function fillColorGrid(
	popover: HTMLElement,
	colors: readonly string[],
	selected: string,
	onPick: (color: string) => void,
): void {
	const doc = popover.ownerDocument;
	for (const color of colors) {
		const button = doc.createElement('button');
		button.type = 'button';
		button.className = 'jot-dock-button jot-dock-color';
		button.dataset.color = color;
		button.style.setProperty('background-color', color, 'important');
		button.setAttribute('aria-label', `Color ${color}`);
		if (color === selected) button.classList.add('is-active');
		button.addEventListener('click', () => onPick(color));
		popover.appendChild(button);
	}
}

// Same scale as Settings → Tool sizes: thousandths of the page height.
export const SIZE_SCALE = 1000;
const SIZE_MIN = 0.5;
const SIZE_MAX = 20;
const SIZE_STEP = 0.5;
/** Preview drawn as if on a page this many pixels tall. */
const PREVIEW_PAGE_PX = 400;
const PREVIEW_HEIGHT = 64;
const PREVIEW_WIDTH = 200;

const TOOL_NAMES: Record<Tool, string> = { pen: 'Pen', highlighter: 'Highlighter', eraser: 'Eraser' };

export interface SizeSliderOptions {
	tool: Tool;
	/** Which preset (0-3) is being edited, or -1 if the current size isn't a preset. */
	presetIndex: number;
	width: number;
	color: string;
	onCommit: (width: number) => void;
}

/** A slider for fine-tuning the selected size, with a live preview. */
export function fillSizeSlider(popover: HTMLElement, options: SizeSliderOptions): void {
	const doc = popover.ownerDocument;
	const header = popover.appendChild(doc.createElement('div'));
	header.className = 'jot-dock-size-header';
	const title = header.appendChild(doc.createElement('span'));
	const name = TOOL_NAMES[options.tool];
	title.textContent = options.presetIndex >= 0 ? `${name} size ${options.presetIndex + 1}` : `${name} size`;
	const valueLabel = header.appendChild(doc.createElement('span'));
	valueLabel.className = 'jot-dock-size-value';

	const svgNs = 'http://www.w3.org/2000/svg';
	const preview = doc.createElementNS(svgNs, 'svg');
	preview.setAttribute('class', 'jot-dock-size-preview');
	preview.setAttribute('viewBox', `0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}`);
	popover.appendChild(preview);

	const slider = popover.appendChild(doc.createElement('input'));
	slider.type = 'range';
	slider.className = 'jot-dock-size-slider';
	slider.min = String(SIZE_MIN);
	slider.max = String(SIZE_MAX);
	slider.step = String(SIZE_STEP);
	slider.value = String(clampToSlider(options.width * SIZE_SCALE));
	slider.setAttribute('aria-label', title.textContent);

	const update = () => {
		const width = Number(slider.value) / SIZE_SCALE;
		valueLabel.textContent = slider.value;
		drawPreview(preview, options.tool, width, options.color);
	};
	slider.addEventListener('input', update);
	slider.addEventListener('change', () => options.onCommit(Number(slider.value) / SIZE_SCALE));
	update();
}

function clampToSlider(value: number): number {
	const stepped = Math.round(value / SIZE_STEP) * SIZE_STEP;
	return Math.max(SIZE_MIN, Math.min(SIZE_MAX, stepped));
}

function drawPreview(svg: SVGElement, tool: Tool, width: number, color: string): void {
	const doc = svg.ownerDocument;
	const svgNs = 'http://www.w3.org/2000/svg';
	svg.replaceChildren();
	const mid = PREVIEW_HEIGHT / 2;
	if (tool === 'eraser') {
		const circle = doc.createElementNS(svgNs, 'circle');
		circle.setAttribute('cx', String(PREVIEW_WIDTH / 2));
		circle.setAttribute('cy', String(mid));
		circle.setAttribute('r', String(Math.min(mid - 2, eraserRadiusFor(width) * PREVIEW_PAGE_PX)));
		circle.setAttribute('class', 'jot-dock-size-preview-eraser');
		svg.appendChild(circle);
		return;
	}
	// Pen thickness at medium pressure (factor 1.15), highlighter 4× and translucent.
	const factor = tool === 'highlighter' ? HIGHLIGHTER_WIDTH_FACTOR : 1.15;
	const thickness = Math.min(PREVIEW_HEIGHT - 4, width * factor * PREVIEW_PAGE_PX);
	const line = doc.createElementNS(svgNs, 'line');
	line.setAttribute('x1', '20');
	line.setAttribute('x2', String(PREVIEW_WIDTH - 20));
	line.setAttribute('y1', String(mid));
	line.setAttribute('y2', String(mid));
	line.setAttribute('stroke', color);
	line.setAttribute('stroke-width', String(thickness));
	line.setAttribute('stroke-linecap', 'round');
	if (tool === 'highlighter') line.setAttribute('stroke-opacity', String(HIGHLIGHTER_ALPHA));
	svg.appendChild(line);
}
