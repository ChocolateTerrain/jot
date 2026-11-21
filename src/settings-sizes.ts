import { Setting, SliderComponent } from 'obsidian';
import { DrawTool, PALETTE_WIDTHS } from './palette';

/** The three size presets for each tool, as fractions of page height. */
export type ToolSizes = Record<DrawTool, number[]>;

export const DEFAULT_TOOL_SIZES: ToolSizes = {
	pen: [...PALETTE_WIDTHS],
	highlighter: [...PALETTE_WIDTHS],
	eraser: [...PALETTE_WIDTHS],
};

// Sliders show sizes in thousandths of the page height, which keeps the
// numbers readable (1.5, 2.5, 5, 9) while strokes stay zoom-independent.
const SLIDER_SCALE = 1000;
const SLIDER_MIN = 0.5;
const SLIDER_MAX = 20;
const SLIDER_STEP = 0.5;

const TOOL_LABELS: { tool: DrawTool; label: string }[] = [
	{ tool: 'pen', label: 'Pen' },
	{ tool: 'highlighter', label: 'Highlighter' },
	{ tool: 'eraser', label: 'Eraser' },
];

/**
 * Repair sizes loaded from disk: three positive numbers per tool. Older
 * versions saved four; keep the three largest (drop the thinnest).
 */
export function sanitizeToolSizes(stored: unknown): ToolSizes {
	const result: ToolSizes = {
		pen: [...DEFAULT_TOOL_SIZES.pen],
		highlighter: [...DEFAULT_TOOL_SIZES.highlighter],
		eraser: [...DEFAULT_TOOL_SIZES.eraser],
	};
	if (!stored || typeof stored !== 'object') return result;
	for (const { tool } of TOOL_LABELS) {
		const raw = (stored as Record<string, unknown>)[tool];
		if (!Array.isArray(raw)) continue;
		let list: unknown[] = raw;
		if (list.length === PALETTE_WIDTHS.length + 1) list = list.slice(1);
		if (list.length !== PALETTE_WIDTHS.length) continue;
		if (list.every((w) => typeof w === 'number' && w > 0 && w < 1)) {
			result[tool] = [...(list as number[])];
		}
	}
	return result;
}

export interface SizeSettingsHost {
	sizes(): ToolSizes;
	updateSize(tool: DrawTool, index: number, width: number): Promise<void>;
	resetSizes(): Promise<void>;
}

export function renderSizeSettings(containerEl: HTMLElement, host: SizeSettingsHost): void {
	new Setting(containerEl)
		.setName('Tool sizes')
		.setDesc(
			'The three size buttons for each tool. Larger numbers draw thicker lines, or a bigger eraser.',
		)
		.setHeading();

	const sliders: { tool: DrawTool; index: number; slider: SliderComponent }[] = [];
	for (const { tool, label } of TOOL_LABELS) {
		host.sizes()[tool].forEach((width, index) => {
			new Setting(containerEl).setName(`${label} size ${index + 1}`).addSlider((slider) => {
				sliders.push({ tool, index, slider });
				slider
					.setLimits(SLIDER_MIN, SLIDER_MAX, SLIDER_STEP)
					.setDynamicTooltip()
					.setValue(toSlider(width))
					.onChange(async (value) => {
						await host.updateSize(tool, index, value / SLIDER_SCALE);
					});
			});
		});
	}

	new Setting(containerEl).addButton((button) =>
		button.setButtonText('Reset tool sizes to defaults').onClick(async () => {
			await host.resetSizes();
			for (const { tool, index, slider } of sliders) {
				slider.setValue(toSlider(host.sizes()[tool][index] ?? PALETTE_WIDTHS[index] ?? 0.005));
			}
		}),
	);
}

function toSlider(width: number): number {
	return Math.round(width * SLIDER_SCALE * 2) / 2;
}
