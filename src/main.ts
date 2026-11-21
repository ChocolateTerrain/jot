import { Events, Notice, Plugin, TFile } from 'obsidian';
import { DEFAULT_TOOL_STATE, Palette, ToolState } from './palette';
import { DockedToolbar } from './docked-toolbar';
import { HighlightLinkController } from './highlight-link-controller';
import { EmbedWatcher } from './embed-watcher';
import { DEFAULT_SETTINGS, JotSettings, JotSettingTab } from './settings';
import { DEFAULT_TOOL_SIZES, SizeSettingsHost, sanitizeToolSizes } from './settings-sizes';
import { clampPenHoldMs } from './pen-hold';
import { ConfirmClearModal } from './clear';
import { collectClearOperations, countStrokes, toUndoEntries } from './clear-ops';
import { PointerEventHandler } from './pointer-event-handler';
import { isSidecarPath, pdfPathFromSidecar } from './jot-file';
import { MergeService } from './merge-service';
import { OverlayManager, SELECT_MODE_CLASS } from './overlay-manager';
import { SidecarStore } from './sidecar-store';
import { StrokeStore } from './stroke-store';
import { UndoController } from './undo-controller';
import { UndoEntry, UndoHistory } from './undo';

export type { Handedness } from './palette';

const PLUGIN_LOG = '[jot]';

export default class JotPlugin extends Plugin {
	private strokes = new StrokeStore();
	private sidecar!: SidecarStore;
	private merge!: MergeService;
	private overlays!: OverlayManager;
	private toolState: ToolState = { ...DEFAULT_TOOL_STATE };
	private palette!: Palette;
	private dockedToolbar: DockedToolbar | null = null;
	private highlightLinks: HighlightLinkController | null = null;
	private embeds: EmbedWatcher | null = null;
	settings: JotSettings = { ...DEFAULT_SETTINGS };
	private history = new UndoHistory();
	private undoController!: UndoController;

	/** Used by the settings tab to edit the per-tool size presets. */
	readonly sizeSettings: SizeSettingsHost = {
		sizes: () => this.settings.sizes,
		updateSize: async (tool, index, width) => {
			const list = this.settings.sizes[tool];
			const old = list[index];
			if (old === undefined) return;
			list[index] = width;
			this.palette.replaceWidth(tool, old, width);
			await this.saveSettings();
		},
		resetSizes: async () => {
			for (const tool of ['pen', 'highlighter', 'eraser'] as const) {
				const list = this.settings.sizes[tool];
				DEFAULT_TOOL_SIZES[tool].forEach((width, index) => {
					const old = list[index];
					if (old !== undefined && old !== width) this.palette.replaceWidth(tool, old, width);
				});
				this.settings.sizes[tool] = [...DEFAULT_TOOL_SIZES[tool]];
			}
			await this.saveSettings();
		},
	};

	async onload() {
		await this.loadSettings();
		this.sidecar = new SidecarStore(this.app.vault.adapter, this.strokes);
		this.overlays = new OverlayManager(this.app, this.strokes, (canvas) =>
			this.wirePointerEvents(canvas),
		);
		this.undoController = new UndoController(this.history, this.strokes, this.overlays, {
			activePdfPath: () => this.overlays.getActivePdfFilePath(),
			onAfterApply: (pdfPath) => {
				this.scheduleSave(pdfPath);
				this.dockedToolbar?.refreshHistory();
			},
		});
		this.merge = new MergeService(
			this.app,
			this.app.vault.adapter,
			this.strokes,
			this.sidecar,
			this.history,
			{
				ensureLoaded: (pdfPath) => this.ensureLoaded(pdfPath),
				redrawOverlays: () => this.overlays.redrawOverlaysForActivePdf(),
			},
		);
		this.addSettingTab(new JotSettingTab(this.app, this));
		this.addCommand({
			id: 'merge-notes-into-pdf',
			name: 'Merge notes into PDF',
			checkCallback: (checking) => {
				const path = this.overlays.getActivePdfFilePath();
				if (!path) return false;
				if (!checking) void this.merge.start(path);
				return true;
			},
		});
		this.addCommand({
			id: 'clear-annotations',
			name: 'Clear annotations on this PDF',
			checkCallback: (checking) => {
				const path = this.overlays.getActivePdfFilePath();
				if (!path) return false;
				if (!this.strokes.hasFor(path)) return false;
				if (!checking) this.startClearFlow(path);
				return true;
			},
		});
		this.palette = new Palette(
			this.toolState,
			(state) => {
				this.toolState = state;
				this.settings.toolState = state;
				const mem = this.palette.getMemory();
				this.settings.penState = mem.pen;
				this.settings.highlighterState = mem.highlighter;
				this.settings.eraserWidth = mem.eraserWidth;
				void this.saveSettings();
				this.applyToolMode();
				this.dockedToolbar?.refresh();
			},
			{
				onUndo: () => this.undoController.undo(),
				onRedo: () => this.undoController.redo(),
				canUndo: () => this.undoController.canUndo(),
				canRedo: () => this.undoController.canRedo(),
				getColors: () => this.settings.colors,
				getWidths: (tool) => this.settings.sizes[tool],
			},
			{
				pen: this.settings.penState,
				highlighter: this.settings.highlighterState,
				eraserWidth: this.settings.eraserWidth,
			},
		);
		this.dockedToolbar = new DockedToolbar(this.palette, {
			onUndo: () => this.undoController.undo(),
			onRedo: () => this.undoController.redo(),
			canUndo: () => this.undoController.canUndo(),
			canRedo: () => this.undoController.canRedo(),
			getColors: () => this.settings.colors,
			setWidthPreset: (tool, index, width) => this.sizeSettings.updateSize(tool, index, width),
		});

		this.highlightLinks = new HighlightLinkController(
			this.app,
			this.strokes,
			this.overlays,
			() => this.toolState.tool,
		);
		this.registerDomEvent(activeDocument, 'click', (e) => this.highlightLinks?.onClick(e));

		this.embeds = new EmbedWatcher(this.app, this.overlays, this.strokes, (pdfPath) =>
			this.loadIfNeeded(pdfPath),
		);
		this.embeds.start(activeDocument);
		// Overlays come and go with scrolling; check Obsidian's link tint each time one appears.
		this.overlays.onOverlayReady = (page) => this.embeds?.checkTints(page);
		// Not in the typings, but Workspace is an Events and 'Page preview' fires it.
		this.registerEvent(
			(this.app.workspace as Events).on('hover-link', (data: unknown) => {
				const { linktext, sourcePath } = (data ?? {}) as { linktext?: string; sourcePath?: string };
				if (linktext) this.embeds?.noteHover(linktext, sourcePath ?? '');
			}),
		);
		this.applyToolMode();

		this.registerEvent(
			this.app.workspace.on('file-open', async (file: TFile | null) => {
				if (file?.extension !== 'pdf') {
					this.dockedToolbar?.hide();
					return;
				}
				await this.ensureLoaded(file.path);
				window.setTimeout(() => {
					this.overlays.attachToActivePdf();
					this.syncDockedToolbar();
				}, 300);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.overlays.pruneClosedObservers();
				this.overlays.attachToActivePdf();
				this.syncDockedToolbar();
			}),
		);

		this.registerEvent(
			this.app.vault.on('modify', async (file) => {
				if (!isSidecarPath(file.path)) return;
				if (await this.sidecar.isOwnSave(file.path)) return;
				const pdfPath = pdfPathFromSidecar(file.path);
				if (pdfPath) await this.reloadSidecar(pdfPath);
			}),
		);

		this.app.workspace.onLayoutReady(async () => {
			const filePath = this.overlays.getActivePdfFilePath();
			if (!filePath) return;
			await this.ensureLoaded(filePath);
			this.overlays.attachToActivePdf();
			this.syncDockedToolbar();
		});

		// The PDF top bar can load after file-open or be rebuilt by Obsidian;
		// re-check cheaply so the toolbar finds (and stays in) it.
		this.registerInterval(window.setInterval(() => this.syncDockedToolbar(), 1000));
	}

	onunload() {
		this.embeds?.stop();
		this.highlightLinks?.hide();
		activeDocument.body.removeClass(SELECT_MODE_CLASS);
		this.overlays?.detachAll();
		this.sidecar?.cancelAllPending();
		this.palette?.hide();
		this.dockedToolbar?.hide();
	}

	/** The select tool lets input through to the PDF (see styles.css). */
	private applyToolMode(): void {
		activeDocument.body.toggleClass(SELECT_MODE_CLASS, this.toolState.tool === 'select');
		if (this.toolState.tool === 'select') this.highlightLinks?.hide();
	}

	private syncDockedToolbar(): void {
		const leaf = this.overlays.getActivePdfLeaf();
		if (!leaf || !this.overlays.getActivePdfFilePath()) {
			this.dockedToolbar?.hide();
			return;
		}
		if (this.settings.toolbarPosition === 'top') {
			const bar = leaf.view.containerEl.querySelector<HTMLElement>('.pdf-toolbar');
			if (bar) {
				this.dockedToolbar?.show(bar, 'inline', bar.querySelector('.pdf-toolbar-right'));
				return;
			}
		}
		this.dockedToolbar?.show(activeDocument.body, 'floating');
	}

	refreshDockedToolbar(): void {
		this.dockedToolbar?.hide();
		this.syncDockedToolbar();
	}

	private async ensureLoaded(pdfPath: string) {
		await this.sidecar.load(pdfPath);
	}

	/**
	 * Load a PDF's annotations for an embed or preview, unless they're already
	 * in memory: reloading would drop strokes whose save is still pending.
	 */
	private async loadIfNeeded(pdfPath: string): Promise<void> {
		if (this.strokes.hasFor(pdfPath) || this.sidecar.hasPendingSave(pdfPath)) return;
		await this.sidecar.load(pdfPath);
	}

	private async reloadSidecar(pdfPath: string) {
		await this.sidecar.load(pdfPath);
		this.overlays.redrawOverlaysForPdf(pdfPath);
	}

	private scheduleSave(pdfPath: string): void {
		this.sidecar.scheduleSave(pdfPath);
	}

	private wirePointerEvents(canvas: HTMLCanvasElement) {
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			console.error(`${PLUGIN_LOG} no 2d context`);
			return;
		}
		new PointerEventHandler(canvas, ctx, {
			palette: this.palette,
			strokes: this.strokes,
			overlays: this.overlays,
			sidecar: this.sidecar,
			undo: this.undoController,
			toolState: () => this.toolState,
			handedness: () => this.settings.handedness,
			penHold: () => ({
				enabled: this.settings.penHoldOpensPalette,
				durationMs: this.settings.penHoldMs,
			}),
			straightenHighlighter: () => this.settings.straightenHighlighter,
			twoFingerDoubleTapUndo: () => this.settings.twoFingerDoubleTapUndo,
			twoFingerHoldOpensPalette: () => this.settings.twoFingerHoldOpensPalette,
			onHighlightDrawn: (canvas, stroke, x, y) => this.highlightLinks?.offer(canvas, stroke, x, y),
			onHistoryChange: () => this.dockedToolbar?.refreshHistory(),
		}).attach();
	}

	async loadSettings() {
		const stored = (await this.loadData()) as Partial<JotSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
		this.settings.penHoldMs = clampPenHoldMs(this.settings.penHoldMs);
		this.settings.sizes = sanitizeToolSizes(stored?.sizes);
		this.toolState = { ...this.settings.toolState };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private pushUndo(entry: UndoEntry) {
		this.undoController.push(entry);
	}

	private startClearFlow(pdfPath: string) {
		new ConfirmClearModal(this.app, pdfPath, () => this.applyClear(pdfPath)).open();
	}

	private applyClear(pdfPath: string) {
		const operations = collectClearOperations(pdfPath, this.strokes.asMap());
		const totalStrokes = countStrokes(operations);
		if (totalStrokes === 0) return;
		for (const entry of toUndoEntries(pdfPath, operations)) {
			this.pushUndo(entry);
			this.strokes.clearKey(entry.key);
		}
		this.scheduleSave(pdfPath);
		this.overlays.redrawOverlaysForActivePdf();
		this.dockedToolbar?.refresh();
		new Notice(
			`Jot: cleared ${totalStrokes} stroke${totalStrokes === 1 ? '' : 's'}. Undo to restore.`,
		);
	}
}



