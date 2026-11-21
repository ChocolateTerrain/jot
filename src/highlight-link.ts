import type { App, TFile, WorkspaceLeaf } from 'obsidian';
import type { Stroke } from './stroke-math';
import { HIGHLIGHTER_WIDTH_FACTOR } from './stroke-render';

interface Pt {
	x: number;
	y: number;
}

/** The highlight's centerline in screen coordinates, and half its thickness. */
function strokeOnScreen(overlay: HTMLElement, stroke: Stroke): { pts: Pt[]; half: number } {
	const rect = overlay.getBoundingClientRect();
	const pts = stroke.points.map((p) => ({
		x: rect.left + p.x * rect.width,
		y: rect.top + p.y * rect.height,
	}));
	const half = (stroke.width * HIGHLIGHTER_WIDTH_FACTOR * rect.height) / 2;
	return { pts, half };
}

export function distanceToPolyline(c: Pt, pts: Pt[]): number {
	if (pts.length === 1) return Math.hypot(c.x - pts[0]!.x, c.y - pts[0]!.y);
	let best = Infinity;
	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i]!;
		const b = pts[i + 1]!;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len2 = dx * dx + dy * dy;
		const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2));
		best = Math.min(best, Math.hypot(c.x - (a.x + dx * t), c.y - (a.y + dy * t)));
	}
	return best;
}

/** True when a screen point lies on the drawn highlight. */
export function hitsStroke(overlay: HTMLElement, stroke: Stroke, x: number, y: number): boolean {
	const { pts, half } = strokeOnScreen(overlay, stroke);
	return pts.length > 0 && distanceToPolyline({ x, y }, pts) <= Math.max(half, 6);
}

/**
 * The PDF text under a highlight, as a DOM Range over the page's text layer.
 * A character counts when its center lies inside the highlight band. The band
 * is capped at about one line's height, so a thick highlight on one line
 * doesn't pick up the lines above and below.
 */
export function rangeUnderStroke(page: HTMLElement, overlay: HTMLElement, stroke: Stroke): Range | null {
	const textLayer = page.querySelector('.textLayer');
	if (!textLayer || stroke.points.length === 0) return null;
	const { pts, half } = strokeOnScreen(overlay, stroke);
	const minX = Math.min(...pts.map((p) => p.x)) - half;
	const maxX = Math.max(...pts.map((p) => p.x)) + half;
	const minY = Math.min(...pts.map((p) => p.y)) - half;
	const maxY = Math.max(...pts.map((p) => p.y)) + half;

	const doc = page.ownerDocument;
	const probe = doc.createRange();
	let start: { node: Text; offset: number } | null = null;
	let end: { node: Text; offset: number } | null = null;
	const walker = doc.createTreeWalker(textLayer, 4 /* NodeFilter.SHOW_TEXT */);
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const box = node.parentElement?.getBoundingClientRect();
		if (!box || box.right < minX || box.left > maxX || box.bottom < minY || box.top > maxY) continue;
		const text = node.data;
		for (let i = 0; i < text.length; i++) {
			probe.setStart(node, i);
			probe.setEnd(node, i + 1);
			const r = probe.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue;
			const tolerance = Math.min(half, Math.max(r.height * 0.6, 4));
			const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
			if (distanceToPolyline(center, pts) > tolerance) continue;
			if (!start) start = { node, offset: i };
			end = { node, offset: i + 1 };
		}
	}
	if (!start || !end) return null;
	snapToWords(start, end);
	const range = doc.createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset);
	return range;
}

/**
 * Highlights often stop partway into a word; widen to whole words and drop
 * spaces at either end.
 */
function snapToWords(start: { node: Text; offset: number }, end: { node: Text; offset: number }): void {
	const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
	const sameNode = start.node === end.node;
	// Trim first, so a highlight ending on a space doesn't grow into the next word.
	while (isSpace(start.node.data[start.offset]) && start.offset < start.node.data.length && (!sameNode || start.offset < end.offset)) {
		start.offset++;
	}
	while (end.offset > 0 && isSpace(end.node.data[end.offset - 1]) && (!sameNode || end.offset > start.offset)) {
		end.offset--;
	}
	while (start.offset > 0 && !isSpace(start.node.data[start.offset - 1])) start.offset--;
	while (end.offset < end.node.data.length && !isSpace(end.node.data[end.offset])) end.offset++;
}

type PdfChild ={ getTextSelectionRangeStr?: (pageEl: HTMLElement) => string | null | undefined };

/**
 * Ask Obsidian's own PDF viewer to describe `range` as a link selection
 * ("a,b,c,d"), exactly as its "Copy link to selection" does: select the range,
 * call the viewer's function, then put the user's selection back. Returns null
 * if this Obsidian version doesn't offer it.
 */
export function nativeSelectionParam(leaf: WorkspaceLeaf, page: HTMLElement, range: Range): string | null {
	const child = (leaf.view as unknown as { viewer?: { child?: PdfChild } }).viewer?.child;
	const describe = child?.getTextSelectionRangeStr;
	const selection = page.ownerDocument.getSelection();
	if (!child || typeof describe !== 'function' || !selection) return null;
	const saved: Range[] = [];
	for (let i = 0; i < selection.rangeCount; i++) saved.push(selection.getRangeAt(i).cloneRange());
	let result: string | null = null;
	try {
		selection.removeAllRanges();
		selection.addRange(range);
		result = describe.call(child, page) ?? null;
	} catch {
		result = null;
	} finally {
		selection.removeAllRanges();
		saved.forEach((r) => selection.addRange(r));
	}
	return result && /^\d+,\d+,\d+,\d+$/.test(result) ? result : null;
}

export interface HighlightLink {
	link: string;
	/** The highlighted text, or '' if none was found under the stroke. */
	text: string;
}

/**
 * A link to the highlight, in the user's link format. With text under the
 * highlight it is a selection link (opens the PDF with that text selected);
 * otherwise a link to the page.
 */
export function buildHighlightLink(
	app: App,
	leaf: WorkspaceLeaf,
	file: TFile,
	pageNumber: number,
	page: HTMLElement,
	overlay: HTMLElement,
	stroke: Stroke,
): HighlightLink {
	const range = rangeUnderStroke(page, overlay, stroke);
	const selection = range ? nativeSelectionParam(leaf, page, range) : null;
	const subpath = `#page=${pageNumber}${selection ? `&selection=${selection}` : ''}`;
	const alias = `${file.basename}, p.${pageNumber}`;
	const link = app.fileManager.generateMarkdownLink(file, '', subpath, alias);
	const text = range ? range.toString().replace(/\s+/g, ' ').trim() : '';
	return { link, text };
}
