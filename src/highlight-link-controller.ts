import { App, Notice, TFile } from 'obsidian';
import { HighlightLinkChip } from './highlight-chip';
import { buildHighlightLink, hitsStroke } from './highlight-link';
import { PAGE_KEY_SEPARATOR } from './jot-file';
import { OVERLAY_KEY_ATTR, OverlayManager } from './overlay-manager';
import type { Tool } from './palette';
import type { Stroke } from './stroke-math';
import type { StrokeStore } from './stroke-store';

const EXCERPT_LENGTH = 60;

/** "Copy link" for highlights: offered after drawing one, or on tap with the select tool. */
export class HighlightLinkController {
	private chip = new HighlightLinkChip();

	constructor(
		private app: App,
		private strokes: StrokeStore,
		private overlays: OverlayManager,
		private currentTool: () => Tool,
	) {}

	/** A highlight was just drawn: briefly offer a link to it. */
	offer(overlay: HTMLCanvasElement, stroke: Stroke, clientX: number, clientY: number): void {
		this.chip.show(overlay.ownerDocument, clientX, clientY, () => void this.copy(overlay, stroke));
	}

	/** With the select tool, tapping a highlight (without selecting text) offers its link. */
	onClick(e: MouseEvent): void {
		if (this.currentTool() !== 'select') return;
		const target = e.target as HTMLElement | null;
		const page = target?.closest?.<HTMLElement>('.page');
		if (!page) return;
		const selection = page.ownerDocument.getSelection();
		if (selection && !selection.isCollapsed) return;
		const overlay = page.querySelector<HTMLCanvasElement>(`canvas[${OVERLAY_KEY_ATTR}]`);
		const key = overlay?.getAttribute(OVERLAY_KEY_ATTR);
		if (!overlay || !key) return;
		const strokes = this.strokes.forKey(key);
		for (let i = strokes.length - 1; i >= 0; i--) {
			const stroke = strokes[i]!;
			if (stroke.tool === 'highlighter' && hitsStroke(overlay, stroke, e.clientX, e.clientY)) {
				this.offer(overlay, stroke, e.clientX, e.clientY);
				return;
			}
		}
	}

	hide(): void {
		this.chip.hide();
	}

	private async copy(overlay: HTMLCanvasElement, stroke: Stroke): Promise<void> {
		const leaf = this.overlays.getActivePdfLeaf();
		const file = (leaf?.view as { file?: TFile } | undefined)?.file;
		const key = overlay.getAttribute(OVERLAY_KEY_ATTR) ?? '';
		const pageNumber = parseInt(key.slice(key.lastIndexOf(PAGE_KEY_SEPARATOR) + PAGE_KEY_SEPARATOR.length), 10);
		const page = overlay.closest<HTMLElement>('.page');
		if (!leaf || !file || !page || Number.isNaN(pageNumber)) {
			new Notice('Jot: could not find the PDF page for this highlight.');
			return;
		}
		const { link, text } = buildHighlightLink(this.app, leaf, file, pageNumber, page, overlay, stroke);
		try {
			await navigator.clipboard.writeText(link);
		} catch {
			new Notice('Jot: could not copy to the clipboard.');
			return;
		}
		const excerpt = text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text;
		new Notice(excerpt ? `Copied link to “${excerpt}”` : `Copied link to page ${pageNumber}`);
	}
}
