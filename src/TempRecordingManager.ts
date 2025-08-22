import { Modal, Notice, Setting } from "obsidian";
import type Whisper from "../main";

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

	async appendChunk(blob: Blob): Promise<void> {
		// Deprecated: maintain for compatibility; redirect to snapshot write
		return this.writeSnapshot(blob);
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
		const ext = this.getExtensionFromMime(mimeType);
		const unifiedPath = `${sessionPath}/recording.${ext}`;
		if (await adapter.exists(unifiedPath)) {
			const data = await adapter.readBinary(unifiedPath);
			return new Blob([new Uint8Array(data)], { type: mimeType });
		}
		// Fallback to legacy chunk assembly if needed
		const listing = await adapter.list(sessionPath);
		const chunks = listing.files
			.filter((f) => f.includes("/chunk-"))
			.sort();
		const parts: Uint8Array[] = [];
		for (const f of chunks) {
			const data = await adapter.readBinary(f);
			parts.push(new Uint8Array(data));
		}
		return new Blob(parts, { type: mimeType });
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
		}
	}
}


