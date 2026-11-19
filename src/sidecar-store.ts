import type { DataAdapter } from 'obsidian';
import {
	isSupportedVersion,
	jotPathFor,
	parseJotText,
} from './jot-file';
import type { StrokeStore } from './stroke-store';

// Saving rewrites the whole PDF's annotations, so wait for a pause in drawing.
const SAVE_DEBOUNCE_MS = 750;

interface WrittenFile {
	text: string;
	size?: number;
	mtime?: number;
}
const PLUGIN_LOG = '[jot]';

export class SidecarStore {
	private saveTimers = new Map<string, number>();
	// What we last wrote to each sidecar, so a modify event can be told apart
	// from our own write echoing back through sync.
	private lastWritten = new Map<string, WrittenFile>();

	constructor(
		private adapter: DataAdapter,
		private strokes: StrokeStore,
	) {}

	async load(pdfPath: string): Promise<void> {
		const path = jotPathFor(pdfPath);
		this.lastWritten.delete(path);
		this.strokes.clearFor(pdfPath);
		try {
			if (!(await this.adapter.exists(path))) return;
			const text = await this.adapter.read(path);
			const parsed = parseJotText(text);
			if (!parsed) return;
			if (!isSupportedVersion(parsed.version)) {
				console.warn(`${PLUGIN_LOG} ${path} has unknown version ${parsed.version}, skipping`);
				return;
			}
			this.strokes.populateFromPayload(pdfPath, parsed.pages);
		} catch (err) {
			console.error(`${PLUGIN_LOG} load failed for ${path}:`, err);
		}
	}

	async save(pdfPath: string): Promise<void> {
		const path = jotPathFor(pdfPath);
		const payload = this.strokes.buildPayload(pdfPath);
		try {
			if (!payload) {
				this.lastWritten.delete(path);
				if (await this.adapter.exists(path)) {
					await this.adapter.remove(path);
				}
				return;
			}
			// No indentation: pretty-printing made large files several times bigger.
			const text = JSON.stringify(payload);
			const record: WrittenFile = { text };
			this.lastWritten.set(path, record);
			await this.adapter.write(path, text);
			// Remember size and time so the echo of this write can be recognised
			// without reading the whole file back.
			const stat = await this.statOf(path);
			if (stat && this.lastWritten.get(path) === record) {
				record.size = stat.size;
				record.mtime = stat.mtime;
			}
		} catch (err) {
			console.error(`${PLUGIN_LOG} save failed for ${path}:`, err);
		}
	}

	scheduleSave(pdfPath: string): void {
		const existing = this.saveTimers.get(pdfPath);
		if (existing !== undefined) window.clearTimeout(existing);
		const id = window.setTimeout(() => {
			this.saveTimers.delete(pdfPath);
			void this.save(pdfPath);
		}, SAVE_DEBOUNCE_MS);
		this.saveTimers.set(pdfPath, id);
	}

	/** True when the sidecar on disk is exactly what we last wrote, i.e. nothing new to load. */
	async isOwnSave(path: string): Promise<boolean> {
		const written = this.lastWritten.get(path);
		if (written === undefined) return false;
		if (written.mtime !== undefined) {
			const stat = await this.statOf(path);
			if (stat) return stat.size === written.size && stat.mtime === written.mtime;
		}
		try {
			return (await this.adapter.read(path)) === written.text;
		} catch {
			return false;
		}
	}

	private async statOf(path: string): Promise<{ size: number; mtime: number } | null> {
		try {
			const stat = await this.adapter.stat?.(path);
			return stat ? { size: stat.size, mtime: stat.mtime } : null;
		} catch {
			return null;
		}
	}

	async discard(pdfPath: string): Promise<void> {
		const path = jotPathFor(pdfPath);
		this.lastWritten.delete(path);
		try {
			if (await this.adapter.exists(path)) {
				await this.adapter.remove(path);
			}
		} catch (err) {
			console.error(`${PLUGIN_LOG} could not delete sidecar ${path}:`, err);
		}
	}

	cancelAllPending(): void {
		this.saveTimers.forEach((id) => window.clearTimeout(id));
		this.saveTimers.clear();
	}
}
