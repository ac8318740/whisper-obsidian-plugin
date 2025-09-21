import { Modal, Notice, Setting } from "obsidian";
import type Whisper from "../main";
import { AudioContextManager } from "src/AudioContextManager";

interface TempManifest {
	mimeType: string;
	startedAt: string; // ISO
	chunkCount: number;
}

export class TempRecordingManager {
	private plugin: Whisper;
	private sessionPath: string | null = null;
	private chunkIndex = 0;
	private mimeType = "";
	private sessionFilePath: string | null = null;

	constructor(plugin: Whisper) {
		this.plugin = plugin;
	}

	private getPluginFolderPath(): string {
		return `.obsidian/plugins/${this.plugin.manifest.id}`;
	}

	private getTmpRootPath(): string {
		return `${this.getPluginFolderPath()}/tmp`;
	}

	private getExtensionFromMime(mime: string): string {
		const parts = mime.split("/");
		if (parts.length > 1) {
			const subtype = parts[1].split(";")[0].trim().toLowerCase();
			return subtype || "dat";
		}
		return "dat";
	}

	async startSession(mimeType: string): Promise<void> {
		this.mimeType = mimeType;
		const adapter = this.plugin.app.vault.adapter;
		const tmpRoot = this.getTmpRootPath();

		if (!(await adapter.exists(tmpRoot))) {
			await adapter.mkdir(tmpRoot);
		}

		const now = new Date();
		const sessionId = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
		this.sessionPath = `${tmpRoot}/session-${sessionId}`;

		await adapter.mkdir(this.sessionPath);

		const ext = this.getExtensionFromMime(mimeType);
		this.sessionFilePath = `${this.sessionPath}/recording.${ext}`;

		const manifest: TempManifest = {
			mimeType,
			startedAt: now.toISOString(),
			chunkCount: 0,
		};
		await adapter.write(
			`${this.sessionPath}/manifest.json`,
			JSON.stringify(manifest, null, 2)
		);
		this.chunkIndex = 0;
	}

	async appendChunk(blob: Blob, chunkIndex?: number): Promise<void> {
		// Handle incremental chunk writing for improved performance
		if (chunkIndex !== undefined) {
			return this.writeIncrementalChunk(blob, chunkIndex);
		}
		// Fallback to old behavior for compatibility
		return this.writeSnapshot(blob);
	}

	private async writeIncrementalChunk(blob: Blob, chunkIndex: number): Promise<void> {
		if (!this.sessionPath) return;
		if (!blob || blob.size === 0) return;

		const adapter = this.plugin.app.vault.adapter;
		const chunkPath = `${this.sessionPath}/chunk-${String(chunkIndex).padStart(4, '0')}.dat`;
		const arrayBuffer = await blob.arrayBuffer();
		await adapter.writeBinary(chunkPath, new Uint8Array(arrayBuffer));

		// Update manifest
		try {
			const manifestPath = `${this.sessionPath}/manifest.json`;
			const manifestRaw = await adapter.read(manifestPath);
			const manifest = JSON.parse(manifestRaw) as TempManifest;
			manifest.chunkCount = Math.max(manifest.chunkCount, chunkIndex + 1);
			await adapter.write(manifestPath, JSON.stringify(manifest, null, 2));
		} catch (e) {
			console.error("Failed to update manifest", e);
		}
	}

	async writeSnapshot(blob: Blob): Promise<void> {
		if (!this.sessionPath) return;
		if (!blob || blob.size === 0) return;
		const adapter = this.plugin.app.vault.adapter;
		const targetPath = this.sessionFilePath || `${this.sessionPath}/recording.${this.getExtensionFromMime(this.mimeType)}`;
		const arrayBuffer = await blob.arrayBuffer();
		await adapter.writeBinary(targetPath, new Uint8Array(arrayBuffer));
		this.chunkIndex += 1;

		// Update manifest chunkCount
		try {
			const manifestPath = `${this.sessionPath}/manifest.json`;
			const manifestRaw = await adapter.read(manifestPath);
			const manifest = JSON.parse(manifestRaw) as TempManifest;
			manifest.chunkCount = this.chunkIndex;
			await adapter.write(manifestPath, JSON.stringify(manifest, null, 2));
		} catch (e) {
			// Non-fatal; continue
		}
	}

	async hasActiveSession(): Promise<boolean> {
		const adapter = this.plugin.app.vault.adapter;
		const tmpRoot = this.getTmpRootPath();
		if (!(await adapter.exists(tmpRoot))) return false;
		const listing = await adapter.list(tmpRoot);
		return listing.folders.some((f) => f.includes("/session-"));
	}

	private async findLatestSessionPath(): Promise<string | null> {
		const adapter = this.plugin.app.vault.adapter;
		const tmpRoot = this.getTmpRootPath();
		if (!(await adapter.exists(tmpRoot))) return null;
		const listing = await adapter.list(tmpRoot);
		const sessionFolders = listing.folders
			.filter((f) => f.includes("/session-"));
		if (sessionFolders.length === 0) return null;
		// Sort by name descending (timestamp encoded in name)
		sessionFolders.sort((a, b) => (a > b ? -1 : 1));
		return sessionFolders[0];
	}

	async promptAndRecoverIfAny(process: (blob: Blob, fileName: string) => Promise<void>): Promise<void> {
		const sessionPath = await this.findLatestSessionPath();
		if (!sessionPath) return;

		// Read manifest for mimeType
		let manifest: TempManifest | null = null;
		try {
			const raw = await this.plugin.app.vault.adapter.read(`${sessionPath}/manifest.json`);
			manifest = JSON.parse(raw) as TempManifest;
		} catch (e) {
			// If manifest missing, still attempt recovery assuming webm
			manifest = { mimeType: "audio/webm", startedAt: new Date().toISOString(), chunkCount: 0 };
		}

		await new Promise<void>((resolve) => {
			const modal = new Modal(this.plugin.app);
			modal.titleEl.setText("Recover unsaved recording?");
			const contentEl = modal.contentEl;
			contentEl.createEl("p", { text: "A previous recording was detected. Would you like to recover and process it now?" });
			if (manifest?.startedAt) {
				contentEl.createEl("p", { text: `Started at: ${new Date(manifest.startedAt).toLocaleString()}` });
			}
			new Setting(contentEl)
				.addButton((b) => b.setButtonText("Discard").onClick(async () => {
					await this.deleteSession(sessionPath);
					modal.close();
					resolve();
				}))
				.addButton((b) => b.setCta().setButtonText("Recover").onClick(async () => {
					try {
						const mime = manifest?.mimeType || "audio/webm";
						const blob = await this.assembleBlobFromSession(sessionPath, mime);
						const ext = this.getExtensionFromMime(mime);
						const fileName = this.generateTimestampedName(ext);
						await process(blob, fileName);
						await this.deleteSession(sessionPath);
						new Notice("Recovered previous recording");
					} catch (err: any) {
						console.error("Recovery failed:", err);
						new Notice("Failed to recover recording: " + err.message);
					}
					modal.close();
					resolve();
				}));
			modal.open();
		});
	}

	private generateTimestampedName(ext: string): string {
		const now = new Date();
		const yyyy = now.getFullYear();
		const mm = String(now.getMonth() + 1).padStart(2, "0");
		const dd = String(now.getDate()).padStart(2, "0");
		const HH = String(now.getHours()).padStart(2, "0");
		const MM = String(now.getMinutes()).padStart(2, "0");
		return `${yyyy}-${mm}-${dd}_${HH}-${MM}.${ext}`;
	}

	private async assembleBlobFromSession(sessionPath: string, mimeType: string): Promise<Blob> {
		const adapter = this.plugin.app.vault.adapter;
		const listing = await adapter.list(sessionPath);

		// Look for chunk files first (new incremental format)
		const chunks = listing.files
			.filter((f) => f.includes("/chunk-"))
			.sort(); // Sorts lexicographically, which works with padded numbers

		if (chunks.length > 0) {
			// Assemble from chunks
			const parts: Uint8Array[] = [];
			for (const chunkFile of chunks) {
				const data = await adapter.readBinary(chunkFile);
				parts.push(new Uint8Array(data));
			}
			const rawBlob = new Blob(parts, { type: mimeType });

			// Convert to WAV for recovery if needed - this ensures compatibility
			if (mimeType !== "audio/wav") {
				try {
					const contextManager = AudioContextManager.getInstance();
					const audioCtx = await contextManager.getContext();
					try {
						const arrayBuffer = await rawBlob.arrayBuffer();
						const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
						const wavBlob = await this.encodeWAV(audioBuffer);
						return wavBlob;
					} finally {
						await contextManager.releaseContext();
					}
				} catch (e) {
					console.warn("Failed to convert to WAV on recovery, using original", e);
					return rawBlob;
				}
			}
			return rawBlob;
		}

		// Fallback to legacy single file if exists
		const ext = this.getExtensionFromMime(mimeType);
		const unifiedPath = `${sessionPath}/recording.${ext}`;
		if (await adapter.exists(unifiedPath)) {
			const data = await adapter.readBinary(unifiedPath);
			return new Blob([new Uint8Array(data)], { type: mimeType });
		}

		throw new Error("No recording data found in session");
	}

	/**
	 * Utility: Re-encode an AudioBuffer as a 16-bit .wav Blob.
	 * Copied from AudioRecorder for use in recovery scenarios.
	 */
	private async encodeWAV(buffer: AudioBuffer): Promise<Blob> {
		const numChannels = buffer.numberOfChannels;
		const sampleRate = buffer.sampleRate;
		const format = 1; // PCM
		const bitsPerSample = 16;

		// Combine channels
		const channelData: Float32Array[] = [];
		const length = buffer.length * numChannels * 2; // 2 bytes per sample
		for (let i = 0; i < numChannels; i++) {
			channelData.push(buffer.getChannelData(i));
		}

		// WAV header 44 bytes + PCM data
		const bufferSize = 44 + length;
		const wavBuffer = new ArrayBuffer(bufferSize);
		const view = new DataView(wavBuffer);

		// RIFF chunk descriptor
		this.writeString(view, 0, "RIFF");
		view.setUint32(4, 36 + length, true); // file size minus 8
		this.writeString(view, 8, "WAVE");

		// fmt sub-chunk
		this.writeString(view, 12, "fmt ");
		view.setUint32(16, 16, true); // Subchunk1Size for PCM
		view.setUint16(20, format, true);
		view.setUint16(22, numChannels, true);
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * numChannels * bitsPerSample / 8, true);
		view.setUint16(32, numChannels * bitsPerSample / 8, true);
		view.setUint16(34, bitsPerSample, true);

		// data sub-chunk
		this.writeString(view, 36, "data");
		view.setUint32(40, length, true);

		// Write PCM
		let offset = 44;
		for (let i = 0; i < buffer.length; i++) {
			for (let ch = 0; ch < numChannels; ch++) {
				const sample = channelData[ch][i];
				// clamp to 16-bit
				const clamped = Math.max(-1, Math.min(1, sample));
				view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF, true);
				offset += 2;
			}
		}

		return new Blob([wavBuffer], { type: "audio/wav" });
	}

	private writeString(view: DataView, offset: number, text: string) {
		for (let i = 0; i < text.length; i++) {
			view.setUint8(offset + i, text.charCodeAt(i));
		}
	}

	async deleteSession(path?: string | null): Promise<void> {
		const adapter: any = this.plugin.app.vault.adapter as any;
		const target = path || this.sessionPath;
		if (!target) return;
		try {
			if (typeof adapter.rmdir === "function") {
				await adapter.rmdir(target, true);
			} else {
				// Fallback: manually remove contents then remove folder
				const listing = await adapter.list(target);
				for (const f of listing.files) {
					await adapter.remove(f);
				}
				for (const d of listing.folders) {
					await this.deleteSession(d);
				}
				await adapter.remove(target);
			}
		} catch (e) {
			console.warn("Failed to remove temp session folder", e);
		}
		if (!path) {
			this.sessionPath = null;
			this.chunkIndex = 0;
			this.mimeType = "";
			this.sessionFilePath = null;
		}
	}
}


