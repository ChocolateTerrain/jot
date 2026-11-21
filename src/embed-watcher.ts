import type { App } from 'obsidian';
import { debugLines, debugNote } from './debug-log';
import { hitsStroke } from './highlight-link';
import { OVERLAY_KEY_ATTR, OverlayManager } from './overlay-manager';
import type { StrokeStore } from './stroke-store';

/** Obsidian's own tint for text opened through a "selection" link. */
const FOCUS_TINT = 'mod-focused';
const TINT_HIDDEN_CLASS = 'jot-tint-hidden';
const OVERLAY_SELECTOR = `canvas[${OVERLAY_KEY_ATTR}]`;
/** After a link is hovered, look for its preview's pages this long after. */
const HOVER_SCAN_DELAYS_MS = [300, 900, 2000];

/**
 * Shows annotations, read-only, on PDF pages outside the PDF tab the plugin
 * manages: hover previews and embeds in notes. Also makes Obsidian's link tint
 * see-through where it lands on one of our highlights, so the highlight shows
 * in the color it was drawn in.
 */
export class EmbedWatcher {
	private observer: MutationObserver | null = null;
	private pendingPages = new Set<HTMLElement>();
	private pendingTints = new Set<HTMLElement>();
	private frame: number | null = null;
	private timers: number[] = [];
	private lastHover: { linktext: string; sourcePath: string } | null = null;
	private reported = new WeakSet<HTMLElement>();
	private stats = { batches: 0, pagesSeen: 0, tintsSeen: 0 };

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
		debugNote('preview watcher started');
	}

	stop(): void {
		this.observer?.disconnect();
		this.observer = null;
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.frame = null;
		this.timers.forEach((id) => window.clearTimeout(id));
		this.timers = [];
		this.pendingPages.clear();
		this.pendingTints.clear();
	}

	/**
	 * A link is being hovered. Remember it (a preview may not say which file it
	 * shows) and look for the preview's pages shortly after, in case their
	 * arrival was missed.
	 */
	noteHover(linktext: string, sourcePath: string): void {
		this.lastHover = { linktext, sourcePath };
		debugNote(`hover-link "${linktext}" from "${sourcePath}"`);
		for (const delay of HOVER_SCAN_DELAYS_MS) {
			this.timers.push(window.setTimeout(() => this.scan(`${delay} ms after hover`), delay));
		}
	}

	/** Queue every unhandled page and tint in the document. */
	scan(reason: string): void {
		const doc = activeDocument;
		let outside = 0;
		doc.querySelectorAll<HTMLElement>('.page').forEach((page) => {
			if (this.overlays.isManaged(page)) return;
			outside++;
			this.pendingPages.add(page);
		});
		const tints = doc.querySelectorAll<HTMLElement>(`.${FOCUS_TINT}`);
		tints.forEach((tint) => this.pendingTints.add(tint));
		debugNote(`scan ${reason}: ${outside} pages outside the managed PDF tab, ${tints.length} tint elements`);
		this.schedule();
	}

	/** Check a page for Obsidian link tints over our highlights (after drawing it). */
	checkTints(page: HTMLElement): void {
		page.querySelectorAll<HTMLElement>(`.${FOCUS_TINT}`).forEach((el) => this.pendingTints.add(el));
		this.schedule();
	}

	/**
	 * What the preview logic saw and decided, plus the PDF pages outside the
	 * managed tab with their surroundings. Pasted back by the user so the DOM
	 * of their Obsidian version can be seen without guessing.
	 */
	debugReport(): string {
		const lines = ['## Recent events', ...debugLines(), ''];
		lines.push(
			`## Watcher: ${this.observer ? 'running' : 'stopped'}, ${this.stats.batches} change batches, ${this.stats.pagesSeen} pages and ${this.stats.tintsSeen} tints seen`,
			'',
		);
		const pages = Array.from(activeDocument.querySelectorAll<HTMLElement>('.page'));
		const outside = pages.filter((page) => !this.overlays.isManaged(page));
		lines.push(`## PDF pages: ${pages.length} in total, ${outside.length} outside the managed PDF tab`);
		outside.slice(0, 15).forEach((page) => lines.push(...this.describePage(page)));
		const tints = activeDocument.querySelectorAll<HTMLElement>(`.${FOCUS_TINT}`);
		lines.push('', `## Tint elements: ${tints.length}`);
		tints.forEach((tint, i) => {
			if (i < 5) lines.push(`- ${tint.tagName.toLowerCase()}.${Array.from(tint.classList).join('.')} in ${describeAncestors(tint)}`);
		});
		return lines.join('\n');
	}

	private describePage(page: HTMLElement): string[] {
		const overlay = page.querySelector(OVERLAY_SELECTOR);
		return [
			`- page ${page.getAttribute('data-page-number') ?? '?'}: overlay=${overlay ? `${overlay.className} key=${overlay.getAttribute(OVERLAY_KEY_ATTR)}` : 'none'}, inPopover=${!!page.closest('.popover')}, resolved=${this.resolvePdf(page) ?? 'none'}`,
			`  ancestors: ${describeAncestors(page)}`,
		];
	}

	// Called for every DOM change in the app, so it must stay cheap.
	private collect(mutations: MutationRecord[]): void {
		this.stats.batches++;
		for (const mutation of mutations) {
			if (mutation.type === 'attributes') {
				const el = mutation.target as HTMLElement;
				if (el.classList?.contains(FOCUS_TINT)) this.addTint(el);
				continue;
			}
			mutation.addedNodes.forEach((node) => {
				if (node.nodeType !== 1) return;
				const el = node as HTMLElement;
				if (el.classList.contains(FOCUS_TINT)) this.addTint(el);
				if (el.classList.contains('page')) this.addPage(el);
				else if (el.firstElementChild) {
					el.querySelectorAll<HTMLElement>('.page').forEach((page) => this.addPage(page));
					el.querySelectorAll<HTMLElement>(`.${FOCUS_TINT}`).forEach((tint) => this.addTint(tint));
				}
			});
		}
		if (this.pendingPages.size > 0 || this.pendingTints.size > 0) this.schedule();
	}

	private addPage(page: HTMLElement): void {
		this.stats.pagesSeen++;
		this.pendingPages.add(page);
	}

	private addTint(tint: HTMLElement): void {
		this.stats.tintsSeen++;
		this.pendingTints.add(tint);
	}

	private schedule(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			const pages = [...this.pendingPages];
			const tints = [...this.pendingTints];
			this.pendingPages.clear();
			this.pendingTints.clear();
			for (const page of pages) {
				this.attach(page).catch((err) => debugNote(`attach failed: ${String(err)}`));
			}
			for (const tint of tints) {
				try {
					this.recolor(tint);
				} catch (err) {
					debugNote(`tint check failed: ${String(err)}`);
				}
			}
		});
	}

	private async attach(page: HTMLElement): Promise<void> {
		if (!page.isConnected || !page.hasAttribute('data-page-number')) return;
		// The PDF tab the plugin manages gets editable overlays from
		// OverlayManager; every other page (hover previews, embeds, other tabs)
		// gets a read-only one here.
		if (this.overlays.isManaged(page)) return;
		if (page.querySelector(OVERLAY_SELECTOR)) return;
		const label = `page ${page.getAttribute('data-page-number')}`;
		const pdfPath = this.resolvePdf(page);
		if (!pdfPath) {
			this.noteOnce(page, `${label}: could not tell which PDF; ancestors: ${describeAncestors(page)}`);
			return;
		}
		await this.loadIfNeeded(pdfPath);
		if (!page.isConnected) return;
		this.overlays.attachReadOnly(page, pdfPath);
		this.noteOnce(page, `${label}: read-only overlay for ${pdfPath}; ancestors: ${describeAncestors(page)}`);
		this.checkTints(page);
	}

	private noteOnce(page: HTMLElement, message: string): void {
		if (this.reported.has(page)) return;
		this.reported.add(page);
		debugNote(message);
	}

	private resolvePdf(page: HTMLElement): string | null {
		const resolve = (linktext: string, sourcePath: string): string | null => {
			const path = linktext.split('#')[0]?.trim() ?? '';
			if (!path) return null;
			const file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
			return file?.extension === 'pdf' ? file.path : null;
		};
		// A PDF view (in a tab or inside a preview) knows its file.
		const leaf = this.overlays.leafContaining(page);
		const viewFile = (leaf?.view as { file?: { path: string; extension: string } } | undefined)?.file;
		if (viewFile?.extension === 'pdf') return viewFile.path;
		const src = page.closest('[src]')?.getAttribute('src');
		const fromSrc = src ? resolve(src, this.lastHover?.sourcePath ?? '') : null;
		if (fromSrc) return fromSrc;
		if (this.lastHover) return resolve(this.lastHover.linktext, this.lastHover.sourcePath);
		return null;
	}

	/** Make the tint see-through where it covers one of our highlights. */
	private recolor(tint: HTMLElement): void {
		if (!tint.isConnected || !tint.classList.contains(FOCUS_TINT) || !tint.closest('.textLayer')) return;
		const page = tint.closest<HTMLElement>('.page');
		const overlay = page?.querySelector<HTMLCanvasElement>(OVERLAY_SELECTOR);
		const key = overlay?.getAttribute(OVERLAY_KEY_ATTR);
		if (!overlay || !key) {
			debugNote(`tint on page ${page?.getAttribute('data-page-number') ?? '?'} without an overlay (yet)`);
			return;
		}
		const box = tint.getBoundingClientRect();
		const x = box.left + box.width / 2;
		const y = box.top + box.height / 2;
		const covered = this.strokes
			.forKey(key)
			.some((stroke) => stroke.tool === 'highlighter' && hitsStroke(overlay, stroke, x, y, box.height / 2));
		tint.classList.toggle(TINT_HIDDEN_CLASS, covered);
		debugNote(`tint on ${key}: ${covered ? 'over a highlight, hidden' : 'not over a highlight'}`);
	}
}

/** "div.popover.hover-popover > div.pdf-embed[src=…] > …", nearest last. */
function describeAncestors(el: HTMLElement): string {
	const parts: string[] = [];
	for (let node = el.parentElement; node && node !== el.ownerDocument.body && parts.length < 12; node = node.parentElement) {
		let part = node.tagName.toLowerCase();
		if (node.classList.length) part += '.' + Array.from(node.classList).join('.');
		for (const attr of ['src', 'data-type']) {
			const value = node.getAttribute(attr);
			if (value) part += `[${attr}="${value.slice(0, 60)}"]`;
		}
		parts.unshift(part);
	}
	return parts.join(' > ');
}
