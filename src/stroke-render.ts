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

const highlighterMasks = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();

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
	let mask = highlighterMasks.get(targetCanvas);
	if (!mask) {
		mask = targetCanvas.ownerDocument.createElement('canvas');
		highlighterMasks.set(targetCanvas, mask);
	}
	if (mask.width !== targetCanvas.width || mask.height !== targetCanvas.height) {
		mask.width = targetCanvas.width;
		mask.height = targetCanvas.height;
	}
	const maskCtx = mask.getContext('2d');
	if (!maskCtx) {
		drawHighlighterPath(ctx, points, color, baseWidth, canvas, HIGHLIGHTER_ALPHA);
		return;
	}
	maskCtx.save();
	maskCtx.setTransform(1, 0, 0, 1, 0, 0);
	maskCtx.clearRect(0, 0, mask.width, mask.height);
	applyDprTransform(maskCtx, canvas);
	maskCtx.lineWidth = baseWidth * HIGHLIGHTER_WIDTH_FACTOR * canvas.height;
	maskCtx.strokeStyle = color;
	maskCtx.lineCap = 'round';
	maskCtx.lineJoin = 'round';
	tracePolyline(maskCtx, points, canvas);
	maskCtx.restore();

	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalAlpha = HIGHLIGHTER_ALPHA;
	ctx.drawImage(mask, 0, 0);
	ctx.restore();
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
