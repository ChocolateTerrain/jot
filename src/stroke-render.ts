import {
	NormalizedPoint,
	Stroke,
	forEachSmoothSegment,
	widthFactorForPressure,
} from './stroke-math';

export interface CanvasSize {
	width: number;
	height: number;
	dpr?: number;
}

export const HIGHLIGHTER_ALPHA = 0.35;
export const HIGHLIGHTER_WIDTH_FACTOR = 4;

interface CachedHighlighter {
	bitmap: HTMLCanvasElement;
	left: number;
	top: number;
}

const highlighterCache = new WeakMap<NormalizedPoint[], Map<string, CachedHighlighter>>();

function denormalize(point: NormalizedPoint, canvas: CanvasSize) {
	return { x: point.x * canvas.width, y: point.y * canvas.height };
}

function applyDprTransform(ctx: CanvasRenderingContext2D, canvas: CanvasSize) {
	const dpr = canvas.dpr ?? 1;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function pressureScaledWidth(
	a: NormalizedPoint,
	b: NormalizedPoint,
	baseWidth: number,
	canvas: CanvasSize,
): number {
	const averagePressure = (a.pressure + b.pressure) / 2;
	return baseWidth * widthFactorForPressure(averagePressure) * canvas.height;
}

export function drawSegment(
	ctx: CanvasRenderingContext2D,
	a: NormalizedPoint,
	b: NormalizedPoint,
	color: string,
	baseWidth: number,
	canvas: CanvasSize,
) {
	applyDprTransform(ctx, canvas);
	ctx.lineWidth = pressureScaledWidth(a, b, baseWidth, canvas);
	ctx.strokeStyle = color;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	const start = denormalize(a, canvas);
	const end = denormalize(b, canvas);
	ctx.beginPath();
	ctx.moveTo(start.x, start.y);
	ctx.lineTo(end.x, end.y);
	ctx.stroke();
}

export function drawHighlighterPolyline(
	ctx: CanvasRenderingContext2D,
	points: NormalizedPoint[],
	color: string,
	baseWidth: number,
	canvas: CanvasSize,
) {
	if (points.length < 2) return;
	const targetCanvas = ctx.canvas;
	if (!targetCanvas || !('ownerDocument' in targetCanvas)) {
		drawHighlighterPath(ctx, points, color, baseWidth, canvas, HIGHLIGHTER_ALPHA);
		return;
	}
	const key = [
		targetCanvas.width,
		targetCanvas.height,
		canvas.width,
		canvas.height,
		canvas.dpr ?? 1,
		baseWidth,
		color,
	].join(':');
	let bitmap = highlighterCache.get(points)?.get(key);
	if (!bitmap) {
		const createdBitmap = createHighlighterBitmap(
			targetCanvas,
			points,
			color,
			baseWidth,
			canvas,
		);
		if (!createdBitmap) {
			drawHighlighterPath(ctx, points, color, baseWidth, canvas, HIGHLIGHTER_ALPHA);
			return;
		}
		bitmap = createdBitmap;
		let entries = highlighterCache.get(points);
		if (!entries) {
			entries = new Map();
			highlighterCache.set(points, entries);
		}
		entries.set(key, bitmap);
	}

	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalAlpha = HIGHLIGHTER_ALPHA;
	ctx.drawImage(bitmap.bitmap, bitmap.left, bitmap.top);
	ctx.restore();
}

function createHighlighterBitmap(
	target: HTMLCanvasElement,
	points: NormalizedPoint[],
	color: string,
	baseWidth: number,
	canvas: CanvasSize,
): CachedHighlighter | null {
	const dpr = canvas.dpr ?? 1;
	const padding = (baseWidth * HIGHLIGHTER_WIDTH_FACTOR * canvas.height) / 2 + 2;
	let minPointX = Infinity;
	let minPointY = Infinity;
	let maxPointX = -Infinity;
	let maxPointY = -Infinity;
	for (const point of points) {
		const x = point.x * canvas.width;
		const y = point.y * canvas.height;
		minPointX = Math.min(minPointX, x);
		minPointY = Math.min(minPointY, y);
		maxPointX = Math.max(maxPointX, x);
		maxPointY = Math.max(maxPointY, y);
	}
	const minX = Math.max(0, minPointX - padding);
	const minY = Math.max(0, minPointY - padding);
	const maxX = Math.min(canvas.width, maxPointX + padding);
	const maxY = Math.min(canvas.height, maxPointY + padding);
	const left = Math.floor(minX * dpr);
	const top = Math.floor(minY * dpr);
	const right = Math.min(target.width, Math.ceil(maxX * dpr));
	const bottom = Math.min(target.height, Math.ceil(maxY * dpr));
	if (right <= left || bottom <= top) return null;

	const bitmap = target.ownerDocument.createElement('canvas');
	bitmap.width = right - left;
	bitmap.height = bottom - top;
	const bitmapCtx = bitmap.getContext('2d');
	if (!bitmapCtx) return null;
	bitmapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
	bitmapCtx.translate(-left / dpr, -top / dpr);
	bitmapCtx.lineWidth = baseWidth * HIGHLIGHTER_WIDTH_FACTOR * canvas.height;
	bitmapCtx.strokeStyle = color;
	bitmapCtx.lineCap = 'round';
	bitmapCtx.lineJoin = 'round';
	tracePolyline(bitmapCtx, points, canvas);
	return { bitmap, left, top };
}

function drawHighlighterPath(
	ctx: CanvasRenderingContext2D,
	points: NormalizedPoint[],
	color: string,
	baseWidth: number,
	canvas: CanvasSize,
	alpha: number,
) {
	ctx.save();
	applyDprTransform(ctx, canvas);
	ctx.lineWidth = baseWidth * HIGHLIGHTER_WIDTH_FACTOR * canvas.height;
	ctx.strokeStyle = color;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	ctx.globalAlpha = alpha;
	tracePolyline(ctx, points, canvas);
	ctx.restore();
}

function tracePolyline(
	ctx: CanvasRenderingContext2D,
	points: NormalizedPoint[],
	canvas: CanvasSize,
) {
	ctx.beginPath();
	const head = denormalize(points[0]!, canvas);
	ctx.moveTo(head.x, head.y);
	for (let i = 1; i < points.length; i++) {
		const next = denormalize(points[i]!, canvas);
		ctx.lineTo(next.x, next.y);
	}
	ctx.stroke();
}

function drawPenPolyline(
	ctx: CanvasRenderingContext2D,
	points: NormalizedPoint[],
	color: string,
	baseWidth: number,
	canvas: CanvasSize,
) {
	if (points.length < 2) return;
	applyDprTransform(ctx, canvas);
	const averagePressure =
		points.reduce((total, point) => total + point.pressure, 0) / points.length;
	ctx.lineWidth = baseWidth * widthFactorForPressure(averagePressure) * canvas.height;
	ctx.strokeStyle = color;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	ctx.beginPath();
	const head = denormalize(points[0]!, canvas);
	ctx.moveTo(head.x, head.y);
	forEachSmoothSegment(points, (_start, end) => {
		const next = denormalize(end, canvas);
		ctx.lineTo(next.x, next.y);
	});
	ctx.stroke();
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, canvas: CanvasSize) {
	if (stroke.tool === 'highlighter') {
		drawHighlighterPolyline(ctx, stroke.points, stroke.color, stroke.width, canvas);
		return;
	}
	drawPenPolyline(ctx, stroke.points, stroke.color, stroke.width, canvas);
}
