import { App, TFile, WorkspaceLeaf } from 'obsidian';
import {
	applyBackingStoreSize,
	cappedPixelRatio,
	devicePixelRatioFor,
	readCanvasSurface,
} from './canvas-surface';
import { pageKey } from './jot-file';
import { drawStroke } from './stroke-render';
import { Bounds, boundsOf, grow, intersects } from './stroke-bounds';
import type { StrokeStore } from './stroke-store';

// Up to 1.0.8, unloading left overlays and per-page observers behind, and
// nothing can disconnect those observers now. They look overlays up by the
// old class, so a new class keeps them from redrawing ours with stale strokes.
const OVERLAY_CLASS = 'jot-overlay-canvas';
const DRAWING_PREVIEW_CLASS = 'jot-drawing-preview';
const LEGACY_OVERLAY_SELECTOR = 'canvas.jot-overlay';
const PAGE_ANCHOR_CLASS = 'jot-page-anchor';
const PASSTHROUGH_CLASS = 'jot-passthrough';
/** Layers the PDF viewer rewrites constantly while scrolling; they never affect overlays. */
const IGNORED_LAYERS = '.textLayer, .annotationLayer';

export const OVERLAY_KEY_ATTR = 'data-jot-key';
/** On <body> while the select tool is active. */
export const SELECT_MODE_CLASS = 'jot-select-mode';

export class OverlayManager {
	private containerObservers = new Map<WorkspaceLeaf, MutationObserver>();
	private swipeGuards = new Map<WorkspaceLeaf, () => void>();
	private pageObservers = new Set<MutationObserver | ResizeObserver | IntersectionObserver>();
	private visiblePages = new WeakSet<HTMLElement>();
	private visibilityObserver: IntersectionObserver | null = null;
	// Tracked here rather than in the DOM: 1.0.8 left its marker attribute on
	// pages whose observers it never disconnected.
	private observedPages = new WeakSet<HTMLElement>();

	constructor(
		private app: App,
		private strokes: StrokeStore,
		private wireOverlay: (canvas: HTMLCanvasElement) => void,
	) {}

	attachToActivePdf(): void {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return;
		const filePath = this.filePathForLeaf(leaf);
		if (!filePath) return;
		const container = leaf.view.containerEl;

		this.upgradePages(container, filePath);
		if (!this.swipeGuards.has(leaf)) this.swipeGuards.set(leaf, guardSelectionSwipes(container));
		if (this.containerObservers.has(leaf)) return;
		// Large PDFs produce a constant stream of DOM changes while scrolling.
		// Only look at pages that actually changed, at most once per frame.
		const pending = new Set<HTMLElement>();
		let scheduled = false;
		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) collectAffectedPages(mutation, pending);
			if (pending.size === 0 || scheduled) return;
			scheduled = true;
			window.requestAnimationFrame(() => {
				scheduled = false;
				const currentPath = this.filePathForLeaf(leaf);
				const pages = [...pending];
				pending.clear();
				if (!currentPath) return;
				for (const page of pages) {
					if (page.isConnected) this.ensureOverlayOnPage(page, currentPath);
				}
			});
		});
		observer.observe(container, { childList: true, subtree: true });
		this.containerObservers.set(leaf, observer);
	}

	pruneClosedObservers(): void {
		if (this.containerObservers.size === 0 && this.swipeGuards.size === 0) return;
		const live = new Set<WorkspaceLeaf>();
		this.app.workspace.iterateAllLeaves((leaf) => live.add(leaf));
		for (const [leaf, observer] of this.containerObservers) {
			if (!live.has(leaf)) {
				observer.disconnect();
				this.containerObservers.delete(leaf);
			}
		}
		for (const [leaf, remove] of this.swipeGuards) {
			if (!live.has(leaf)) {
				remove();
				this.swipeGuards.delete(leaf);
			}
		}
	}

	/**
	 * Undo everything attachToActivePdf did. The overlays must go too: their
	 * pointer listeners close over this plugin instance, so leaving them behind
	 * on unload would keep the old instance — and its settings — drawing until
	 * Obsidian restarts, and stop the next instance from wiring those pages.
	 */
	detachAll(): void {
		this.containerObservers.forEach((observer) => observer.disconnect());
		this.containerObservers.clear();
		this.swipeGuards.forEach((remove) => remove());
		this.swipeGuards.clear();
		this.pageObservers.forEach((observer) => observer.disconnect());
		this.pageObservers.clear();
		this.visibilityObserver = null;
		this.visiblePages = new WeakSet();
		this.observedPages = new WeakSet();
		this.app.workspace.iterateAllLeaves((leaf) => {
			const container = leaf.view.containerEl;
			container.querySelectorAll(`canvas.${OVERLAY_CLASS}`).forEach((el) => el.remove());
			container.querySelectorAll(`canvas.${DRAWING_PREVIEW_CLASS}`).forEach((el) => el.remove());
			container
				.querySelectorAll(`.${PAGE_ANCHOR_CLASS}`)
				.forEach((page) => page.classList.remove(PAGE_ANCHOR_CLASS));
			container
				.querySelectorAll(`.${PASSTHROUGH_CLASS}`)
				.forEach((el) => el.classList.remove(PASSTHROUGH_CLASS));
		});
	}

	/**
	 * Redraw a page's annotations. With `dirty` (normalized page area), only
	 * that area is cleared and only strokes reaching into it are drawn, which
	 * keeps erasing smooth on pages full of ink.
	 */
	redrawPage(canvas: HTMLCanvasElement, dirty?: Bounds): void {
		if (canvas.width === 0 || canvas.height === 0) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const surface = readCanvasSurface(canvas);
		ctx.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
		const key = canvas.getAttribute(OVERLAY_KEY_ATTR);
		if (!dirty) {
			ctx.clearRect(0, 0, surface.width, surface.height);
			if (!key) return;
			for (const stroke of this.strokes.forKey(key)) drawStroke(ctx, stroke, surface);
			return;
		}
		// Whole device pixels, so the clipped edge doesn't leave seams.
		const x = Math.floor(Math.max(0, dirty.minX) * surface.width * surface.dpr) / surface.dpr;
		const y = Math.floor(Math.max(0, dirty.minY) * surface.height * surface.dpr) / surface.dpr;
		const right = Math.ceil(Math.min(1, dirty.maxX) * surface.width * surface.dpr) / surface.dpr;
		const bottom = Math.ceil(Math.min(1, dirty.maxY) * surface.height * surface.dpr) / surface.dpr;
		if (right <= x || bottom <= y) return;
		ctx.save();
		ctx.beginPath();
		ctx.rect(x, y, right - x, bottom - y);
		ctx.clip();
		ctx.clearRect(x, y, right - x, bottom - y);
		if (key) {
			for (const stroke of this.strokes.forKey(key)) {
				// Generous margin: the widest a stroke can draw (highlighter, 4x).
				const margin = stroke.width * 4 * surface.height;
				const reach = grow(boundsOf(stroke.points), margin / surface.width, margin / surface.height);
				if (intersects(reach, dirty)) drawStroke(ctx, stroke, surface);
			}
		}
		ctx.restore();
	}

	redrawOverlaysForActivePdf(): void {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return;
		this.canvasesIn(leaf).forEach((canvas) => this.redrawPage(canvas));
	}

	redrawOverlaysForPdf(pdfPath: string): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (this.filePathForLeaf(leaf) !== pdfPath) return;
			this.canvasesIn(leaf).forEach((canvas) => this.redrawPage(canvas));
		});
	}

	overlayForKey(key: string): HTMLCanvasElement | null {
		const leaf = this.getActivePdfLeaf();
		if (!leaf) return null;
		const escaped = key.replace(/["\\]/g, '\\$&');
		return leaf.view.containerEl.querySelector<HTMLCanvasElement>(
			`canvas.${OVERLAY_CLASS}[${OVERLAY_KEY_ATTR}="${escaped}"]`,
		);
	}

	getActivePdfLeaf(): WorkspaceLeaf | null {
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!leaf) return null;
		const viewType = leaf.view.getViewType?.();
		if (viewType !== 'pdf') return null;
		return leaf;
	}

	getActivePdfFilePath(): string | null {
		const leaf = this.getActivePdfLeaf();
		return leaf ? this.filePathForLeaf(leaf) : null;
	}

	private filePathForLeaf(leaf: WorkspaceLeaf): string | null {
		const file = (leaf.view as { file?: TFile }).file;
		return file?.path ?? null;
	}

	private canvasesIn(leaf: WorkspaceLeaf): NodeListOf<HTMLCanvasElement> {
		return leaf.view.containerEl.querySelectorAll<HTMLCanvasElement>(
			`canvas.${OVERLAY_CLASS}`,
		);
	}

	private upgradePages(container: HTMLElement, filePath: string): void {
		container
			.querySelectorAll<HTMLElement>('.page')
			.forEach((page) => this.ensureOverlayOnPage(page, filePath));
	}

	private ensureOverlayOnPage(page: HTMLElement, filePath: string): void {
		const pageNumberAttr = page.getAttribute('data-page-number');
		const pageNumber = pageNumberAttr ? parseInt(pageNumberAttr, 10) : NaN;
		if (Number.isNaN(pageNumber)) return;
		const key = pageKey(filePath, pageNumber);
		const host = this.overlayHostForPage(page);
		this.observePageVisibility(page);

		page.querySelector(LEGACY_OVERLAY_SELECTOR)?.remove();
		const existing = page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);
		if (existing) {
			if (existing.getAttribute(OVERLAY_KEY_ATTR) === key) {
				// Already in place: its resize and visibility observers keep it
				// sized and drawn, so skip the (expensive) layout reads here.
				if (host.contains(existing)) return;
				host.appendChild(existing);
				this.sizeOverlayToPage(existing, page);
				this.redrawPage(existing);
				return;
			}
			existing.remove();
		}

		page.classList.add(PAGE_ANCHOR_CLASS);
		if (host !== page && window.getComputedStyle(host).position === 'static') {
			host.classList.add(PAGE_ANCHOR_CLASS);
		}
		const overlay = activeDocument.createElement('canvas');
		overlay.className = OVERLAY_CLASS;
		overlay.width = 0;
		overlay.height = 0;
		overlay.setAttribute(OVERLAY_KEY_ATTR, key);
		this.sizeOverlayToPage(overlay, page);
		host.appendChild(overlay);
		this.disableTextLayerInteraction(page);
		this.wireOverlay(overlay);
		this.redrawPage(overlay);

		if (this.observedPages.has(page)) return;
		this.observedPages.add(page);

		const findOverlay = () =>
			page.querySelector<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`);

		const mutationObserver = new MutationObserver(() => {
			const current = findOverlay();
			if (!current) return;
			this.disableTextLayerInteraction(page);
			const currentHost = this.overlayHostForPage(page);
			if (!currentHost.contains(current)) {
				this.sizeOverlayToPage(current, page);
				currentHost.appendChild(current);
				this.redrawPage(current);
			}
		});
		mutationObserver.observe(page, { childList: true });
		this.pageObservers.add(mutationObserver);

		const resizeObserver = new ResizeObserver(() => {
			const current = findOverlay();
			if (!current) return;
			this.sizeOverlayToPage(current, page);
			this.redrawPage(current);
		});
		resizeObserver.observe(page);
		this.pageObservers.add(resizeObserver);
	}

	private overlayHostForPage(page: HTMLElement): HTMLElement {
		return page.querySelector<HTMLElement>('.canvasWrapper') ?? page;
	}

	private pdfCanvasForPage(page: HTMLElement): HTMLCanvasElement | null {
		return (
			page.querySelector<HTMLCanvasElement>(
				'.canvasWrapper canvas:not(.jot-overlay-canvas)',
			) ?? page.querySelector<HTMLCanvasElement>('canvas:not(.jot-overlay-canvas)')
		);
	}

	private observePageVisibility(page: HTMLElement): void {
		if (typeof IntersectionObserver === 'undefined') {
			this.visiblePages.add(page);
			return;
		}
		if (!this.visibilityObserver) {
			this.visibilityObserver = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						const targetPage = entry.target as HTMLElement;
					const overlay = targetPage.querySelector<HTMLCanvasElement>(
						`canvas.${OVERLAY_CLASS}`,
					);
					if (!overlay) continue;
					if (entry.isIntersecting) {
						this.visiblePages.add(targetPage);
						this.sizeOverlayToPage(overlay, targetPage);
						this.redrawPage(overlay);
					} else {
						this.visiblePages.delete(targetPage);
						applyBackingStoreSize(overlay, 0, 0, 1);
					}
					}
				},
				{ rootMargin: '100% 0px' },
			);
			this.pageObservers.add(this.visibilityObserver);
		}
		this.visibilityObserver.observe(page);
	}

	private sizeOverlayToPage(overlay: HTMLCanvasElement, page: HTMLElement): void {
		const host = this.overlayHostForPage(page);
		const hostRect = host.getBoundingClientRect();
		const pdfCanvasRect = this.pdfCanvasForPage(page)?.getBoundingClientRect();
		const rect =
			pdfCanvasRect && pdfCanvasRect.width > 0 && pdfCanvasRect.height > 0
				? pdfCanvasRect
				: hostRect;
		if (rect.width === 0 || rect.height === 0) return;
		const scaleX = host.offsetWidth > 0 ? hostRect.width / host.offsetWidth : 1;
		const scaleY = host.offsetHeight > 0 ? hostRect.height / host.offsetHeight : 1;
		const cssWidth = rect.width / scaleX;
		const cssHeight = rect.height / scaleY;
		overlay.style.left = `${(rect.left - hostRect.left) / scaleX - host.clientLeft}px`;
		overlay.style.top = `${(rect.top - hostRect.top) / scaleY - host.clientTop}px`;
		overlay.style.width = `${cssWidth}px`;
		overlay.style.height = `${cssHeight}px`;
		if (!this.visiblePages.has(page)) {
			applyBackingStoreSize(overlay, 0, 0, 1);
			return;
		}
		const dpr = cappedPixelRatio(cssWidth, cssHeight, devicePixelRatioFor(window));
		applyBackingStoreSize(overlay, cssWidth, cssHeight, dpr);
	}

	private disableTextLayerInteraction(page: HTMLElement): void {
		page.querySelector<HTMLElement>('.textLayer')?.classList.add(PASSTHROUGH_CLASS);
		page.querySelector<HTMLElement>('.annotationLayer')?.classList.add(PASSTHROUGH_CLASS);
	}
}

/** Add the pages a DOM change could affect to `pages`; ignore text/annotation layer churn. */
function collectAffectedPages(mutation: MutationRecord, pages: Set<HTMLElement>): void {
	if (!isElement(mutation.target)) return;
	const target = mutation.target;
	if (target.closest(IGNORED_LAYERS)) return;
	const changed = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
	let relevant = false;
	for (const node of changed) {
		if (!isElement(node)) continue;
		if (node.matches(IGNORED_LAYERS)) continue;
		// Our own drawing preview comes and goes with every stroke.
		if (node.classList.contains(DRAWING_PREVIEW_CLASS)) continue;
		if (node.matches('.page')) pages.add(node as HTMLElement);
		node.querySelectorAll<HTMLElement>('.page').forEach((page) => pages.add(page));
		relevant = true;
	}
	if (!relevant) return;
	const page = target.closest<HTMLElement>('.page');
	if (page) pages.add(page);
}

/** Cross-window safe (popout windows have their own Element class). */
function isElement(node: Node): node is Element {
	return node.nodeType === 1;
}

/**
 * With the select tool, a finger drag on a PDF page (e.g. moving a text
 * selection handle) is for the PDF. Obsidian on iPad would take a sideways
 * drag as "swipe to open a sidebar", so stop page touches from bubbling up to
 * it. They still reach the page itself; scrolling and selecting are native and
 * unaffected. Returns a function that removes the guard.
 */
function guardSelectionSwipes(container: HTMLElement): () => void {
	const stop = (e: TouchEvent) => {
		if (!container.ownerDocument.body.classList.contains(SELECT_MODE_CLASS)) return;
		const target = e.target as HTMLElement | null;
		if (!target?.closest?.('.page')) return;
		e.stopPropagation();
	};
	const types = ['touchstart', 'touchmove', 'touchend'] as const;
	types.forEach((type) => container.addEventListener(type, stop, { passive: true }));
	return () => types.forEach((type) => container.removeEventListener(type, stop));
}
