import { App, TFile, WorkspaceLeaf } from 'obsidian';
import {
	applyBackingStoreSize,
	cappedPixelRatio,
	devicePixelRatioFor,
	readCanvasSurface,
} from './canvas-surface';
import { pageKey } from './jot-file';
import { drawStroke } from './stroke-render';
import type { StrokeStore } from './stroke-store';

// Up to 1.0.8, unloading left overlays and per-page observers behind, and
// nothing can disconnect those observers now. They look overlays up by the
// old class, so a new class keeps them from redrawing ours with stale strokes.
const OVERLAY_CLASS = 'jot-overlay-canvas';
const LEGACY_OVERLAY_SELECTOR = 'canvas.jot-overlay';
const PAGE_ANCHOR_CLASS = 'jot-page-anchor';
const PASSTHROUGH_CLASS = 'jot-passthrough';

export const OVERLAY_KEY_ATTR = 'data-jot-key';

export class OverlayManager {
	private containerObservers = new Map<WorkspaceLeaf, MutationObserver>();
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
		if (this.containerObservers.has(leaf)) return;
		const observer = new MutationObserver(() => {
			const currentPath = this.filePathForLeaf(leaf);
			if (!currentPath) return;
			this.upgradePages(container, currentPath);
		});
		observer.observe(container, { childList: true, subtree: true });
		this.containerObservers.set(leaf, observer);
	}

	pruneClosedObservers(): void {
		if (this.containerObservers.size === 0) return;
		const live = new Set<WorkspaceLeaf>();
		this.app.workspace.iterateAllLeaves((leaf) => live.add(leaf));
		for (const [leaf, observer] of this.containerObservers) {
			if (!live.has(leaf)) {
				observer.disconnect();
				this.containerObservers.delete(leaf);
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
		this.pageObservers.forEach((observer) => observer.disconnect());
		this.pageObservers.clear();
		this.visibilityObserver = null;
		this.visiblePages = new WeakSet();
		this.observedPages = new WeakSet();
		this.app.workspace.iterateAllLeaves((leaf) => {
			const container = leaf.view.containerEl;
			container.querySelectorAll(`canvas.${OVERLAY_CLASS}`).forEach((el) => el.remove());
			container
				.querySelectorAll(`.${PAGE_ANCHOR_CLASS}`)
				.forEach((page) => page.classList.remove(PAGE_ANCHOR_CLASS));
			container
				.querySelectorAll(`.${PASSTHROUGH_CLASS}`)
				.forEach((el) => el.classList.remove(PASSTHROUGH_CLASS));
		});
	}

	redrawPage(canvas: HTMLCanvasElement): void {
		if (canvas.width === 0 || canvas.height === 0) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const surface = readCanvasSurface(canvas);
		ctx.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
		ctx.clearRect(0, 0, surface.width, surface.height);
		const key = canvas.getAttribute(OVERLAY_KEY_ATTR);
		if (!key) return;
		for (const stroke of this.strokes.forKey(key)) {
			drawStroke(ctx, stroke, surface);
		}
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
				if (!host.contains(existing)) host.appendChild(existing);
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
		overlay.style.left = `${rect.left - hostRect.left}px`;
		overlay.style.top = `${rect.top - hostRect.top}px`;
		overlay.style.width = `${rect.width}px`;
		overlay.style.height = `${rect.height}px`;
		if (!this.visiblePages.has(page)) {
			applyBackingStoreSize(overlay, 0, 0, 1);
			return;
		}
		const dpr = cappedPixelRatio(rect.width, rect.height, devicePixelRatioFor(window));
		applyBackingStoreSize(overlay, rect.width, rect.height, dpr);
	}

	private disableTextLayerInteraction(page: HTMLElement): void {
		page.querySelector<HTMLElement>('.textLayer')?.classList.add(PASSTHROUGH_CLASS);
		page.querySelector<HTMLElement>('.annotationLayer')?.classList.add(PASSTHROUGH_CLASS);
	}
}
