import type { CanvasSize } from './stroke-render';
import { drawSegment, HIGHLIGHTER_ALPHA, HIGHLIGHTER_WIDTH_FACTOR } from './stroke-render';
import type { NormalizedPoint } from './stroke-math';
import type { ToolState } from './palette';

export const DRAWING_PREVIEW_CLASS = 'jot-drawing-preview';

/**
 * One preview canvas per window, reused for every stroke. Allocating a fresh
 * page-sized canvas (about 12 MB on an iPad) at each pen-down caused a hitch.
 */
const reusable = new WeakMap<
	Document,
	{ canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }
>();

export class DrawingPreview {
	private constructor(
		private canvas: HTMLCanvasElement,
		private context: CanvasRenderingContext2D,
		private tool: ToolState['tool'],
	) {}

	static create(source: HTMLCanvasElement, tool: ToolState['tool']): DrawingPreview | null {
		const parent = source.parentElement;
		if (!parent) return null;

		const doc = source.ownerDocument;
		let entry = reusable.get(doc);
		if (!entry) {
			const canvas = doc.createElement('canvas');
			canvas.className = DRAWING_PREVIEW_CLASS;
			const context = canvas.getContext('2d');
			if (!context) return null;
			entry = { canvas, context };
			reusable.set(doc, entry);
		}
		const { canvas: preview, context } = entry;
		if (preview.width !== source.width || preview.height !== source.height) {
			// Resizing also clears it.
			preview.width = source.width;
			preview.height = source.height;
		} else {
			context.setTransform(1, 0, 0, 1, 0, 0);
			context.clearRect(0, 0, preview.width, preview.height);
		}
		preview.style.left = source.style.left;
		preview.style.top = source.style.top;
		preview.style.width = source.style.width;
		preview.style.height = source.style.height;
		preview.style.opacity = tool === 'highlighter' ? String(HIGHLIGHTER_ALPHA) : '';
		parent.insertBefore(preview, source.nextSibling);
		return new DrawingPreview(preview, context, tool);
	}

	drawSegment(
		start: NormalizedPoint,
		end: NormalizedPoint,
		color: string,
		width: number,
		surface: CanvasSize,
	): void {
		if (this.tool !== 'highlighter') {
			drawSegment(this.context, start, end, color, width, surface);
			return;
		}

		this.context.setTransform(surface.dpr ?? 1, 0, 0, surface.dpr ?? 1, 0, 0);
		this.context.lineWidth = width * HIGHLIGHTER_WIDTH_FACTOR * surface.height;
		this.context.strokeStyle = color;
		this.context.lineCap = 'round';
		this.context.lineJoin = 'round';
		this.context.beginPath();
		this.context.moveTo(start.x * surface.width, start.y * surface.height);
		this.context.lineTo(end.x * surface.width, end.y * surface.height);
		this.context.stroke();
	}

	destroy(): void {
		this.canvas.remove();
	}
}