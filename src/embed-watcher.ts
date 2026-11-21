import type { App } from 'obsidian';
import { hitsStroke } from './highlight-link';
import { OVERLAY_KEY_ATTR, OverlayManager } from './overlay-manager';
import type { StrokeStore } from './stroke-store';

/** Obsidian's own tint for text opened through a "selection" link. */
const FOCUS_TINT = 'mod-focused';
const TINT_HIDDEN_CLASS = 'jot-tint-hidden';
const OVERLAY_SELECTOR = `canvas[${OVERLAY_KEY_ATTR}]`;

/**
 * Shows annotations, read-only, in PDF embeds and hover previews, which are
 * not workspace tabs and so are not covered by the main overlay logic. Also
 * makes Obsidian's link tint see-through where it lands on one of our
 * highlights, so the highlight shows in the color it was drawn in.
 */
export class EmbedWatcher {
	private observer: MutationObserver | null = null;
	private pendingPages = new Set<HTMLElement>();
	private pendingTints = new Set<HTMLElement>();
	private frame: number | null = null;
	private lastHover: { linktext: string; sourcePath: string } | null = null;

	constructor(
		private app: App,
		private overlays: OverlayManager,
		private strokes: StrokeStore,
		private loadIfNeeded: (pdfPath: string) => Promise<void>,
	) {}

	start(doc: Document): void {
		if (this.observer) return;
		this.observer = new MutationObserver((mutations) => this.collect(mutations));
		this.observer.observe(doc.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['class'],
		});
	}

	stop(): void {
		this.observer?.disconnect();
		this.observer = null;
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.frame = null;
		this.pendingPages.clear();
		this.pendingTints.clear();
	}

	/** Remember the link being hovered: a hover preview's PDF may not say which file it shows. */
	noteHover(linktext: string, sourcePath: string): void {
		this.lastHover = { linktext, sourcePath };
	}

	/** Check a page for Obsidian link tints over our highlights (after drawing it). */
	checkTints(page: HTMLElement): void {
		page.querySelectorAll<HTMLElement>(`.textLayer .${FOCUS_TINT}`).forEach((el) => this.pendingTints.add(el));
		this.schedule();
	}

	// Called for every DOM change in the app, so it must stay cheap.
	private collect(mutations: MutationRecord[]): void {
		for (const mutation of mutations) {
			if (mutation.type === 'attributes') {
				const el = mutation.target as HTMLElement;
				if (el.classList?.contains(FOCUS_TINT)) this.pendingTints.add(el);
				continue;
			}
			mutation.addedNodes.forEach((node) => {
				if (node.nodeType !== 1) return;
				const el = node as HTMLElement;
				if (el.classList.contains(FOCUS_TINT)) this.pendingTints.add(el);
				if (el.classList.contains('page')) this.pendingPages.add(el);
				else if (el.firstElementChild) {
					el.querySelectorAll<HTMLElement>('.page').forEach((page) => this.pendingPages.add(page));
				}
			});
		}
		if (this.pendingPages.size > 0 || this.pendingTints.size > 0) this.schedule();
	}

	private schedule(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			const pages = [...this.pendingPages];
			const tints = [...this.pendingTints];
			this.pendingPages.clear();
			this.pendingTints.clear();
			pages.forEach((page) => void this.attach(page));
			tints.forEach((tint) => this.recolor(tint));
		});
	}

	private async attach(page: HTMLElement): Promise<void> {
		if (!page.isConnected || !page.hasAttribute('data-page-number')) return;
		// Pages in a PDF tab are handled by OverlayManager.attachToActivePdf.
		// A hover preview may host a PDF view of its own; that still counts as
		// a preview.
		if (!page.closest('.popover') && this.overlays.isInPdfTab(page)) return;
		if (page.querySelector(OVERLAY_SELECTOR)) return;
		const pdfPath = this.resolvePdf(page);
		if (!pdfPath) return;
		await this.loadIfNeeded(pdfPath);
		if (!page.isConnected) return;
		this.overlays.attachReadOnly(page, pdfPath);
		this.checkTints(page);
	}

	private resolvePdf(page: HTMLElement): string | null {
		const resolve = (linktext: string, sourcePath: string): string | null => {
			const path = linktext.split('#')[0]?.trim() ?? '';
			if (!path) return null;
			const file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
			return file?.extension === 'pdf' ? file.path : null;
		};
		// A PDF view inside the preview knows its file.
		const leaf = this.overlays.leafContaining(page);
		const viewFile = (leaf?.view as { file?: { path: string; extension: string } } | undefined)?.file;
		if (viewFile?.extension === 'pdf') return viewFile.path;
		const src = page.closest('[src]')?.getAttribute('src');
		const fromSrc = src ? resolve(src, this.lastHover?.sourcePath ?? '') : null;
		if (fromSrc) return fromSrc;
		if (page.closest('.popover') && this.lastHover) {
			return resolve(this.lastHover.linktext, this.lastHover.sourcePath);
		}
		return null;
	}

	/** Make the tint see-through where it covers one of our highlights. */
	private recolor(tint: HTMLElement): void {
		if (!tint.isConnected || !tint.classList.contains(FOCUS_TINT) || !tint.closest('.textLayer')) return;
		const overlay = tint.closest('.page')?.querySelector<HTMLCanvasElement>(OVERLAY_SELECTOR);
		const key = overlay?.getAttribute(OVERLAY_KEY_ATTR);
		if (!overlay || !key) return;
		const box = tint.getBoundingClientRect();
		const x = box.left + box.width / 2;
		const y = box.top + box.height / 2;
		const covered = this.strokes
			.forKey(key)
			.some((stroke) => stroke.tool === 'highlighter' && hitsStroke(overlay, stroke, x, y, box.height / 2));
		tint.classList.toggle(TINT_HIDDEN_CLASS, covered);
	}
}
