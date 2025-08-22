import { App, Modal, Notice, Setting } from "obsidian";
import type Whisper from "../main";

interface TempManifest {
	mimeType: string;
	startedAt: string; // ISO
	chunkCount: number;
}

export class TempRecordingManager {
	private plugin: Whisper;
	private sessionPath: string | null = null;
	private chunkIndex: number = 0;
	private mimeType: string = "";

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
		return parts.length > 1 ? parts[1] : "dat";
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
		if (!this.sessionPath) return;
		if (!blob || blob.size === 0) return;
		const adapter = this.plugin.app.vault.adapter;
		const ext = this.getExtensionFromMime(this.mimeType);
		const chunkName = `chunk-${String(this.chunkIndex).padStart(6, "0")}.${ext}`;
		const chunkPath = `${this.sessionPath}/${chunkName}`;
		const arrayBuffer = await blob.arrayBuffer();
		await adapter.writeBinary(chunkPath, new Uint8Array(arrayBuffer));
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
		return listing.folders.some((f) => f.endsWith("/session-") === false); // any folder is enough
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
						const blob = await this.assembleBlobFromSession(sessionPath, manifest!.mimeType);
						const ext = this.getExtensionFromMime(manifest!.mimeType);
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
		const adapter = this.plugin.app.vault.adapter;
		const target = path || this.sessionPath;
		if (!target) return;
		try {
			const listing = await adapter.list(target);
			for (const f of listing.files) {
				await adapter.remove(f);
			}
			for (const d of listing.folders) {
				// Best-effort recursive delete
				await this.deleteSession(d);
			}
			// Finally remove the folder itself
			// @ts-ignore - remove should handle folders in Obsidian's adapter
			await adapter.remove(target);
		} catch (e) {
			// Ignore failures
		}
		if (!path) {
			this.sessionPath = null;
			this.chunkIndex = 0;
			this.mimeType = "";
		}
	}
}


