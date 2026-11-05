import type { CanvasSize } from './stroke-render';
import { drawSegment, HIGHLIGHTER_ALPHA, HIGHLIGHTER_WIDTH_FACTOR } from './stroke-render';
import type { NormalizedPoint } from './stroke-math';
import type { ToolState } from './palette';

export const DRAWING_PREVIEW_CLASS = 'jot-drawing-preview';

export class DrawingPreview {
	private constructor(
		private canvas: HTMLCanvasElement,
		private context: CanvasRenderingContext2D,
		private tool: ToolState['tool'],
	) {}

	static create(source: HTMLCanvasElement, tool: ToolState['tool']): DrawingPreview | null {
		const parent = source.parentElement;
		if (!parent) return null;

		const preview = source.ownerDocument.createElement('canvas');
		preview.className = DRAWING_PREVIEW_CLASS;
		preview.width = source.width;
		preview.height = source.height;
		preview.style.left = source.style.left;
		preview.style.top = source.style.top;
		preview.style.width = source.style.width;
		preview.style.height = source.style.height;
		if (tool === 'highlighter') preview.style.opacity = String(HIGHLIGHTER_ALPHA);
		parent.insertBefore(preview, source.nextSibling);

		const context = preview.getContext('2d');
		if (!context) {
			preview.remove();
			return null;
		}
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