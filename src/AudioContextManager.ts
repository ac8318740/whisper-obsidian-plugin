/**
 * Manages a shared AudioContext to prevent resource leaks
 *
 * This singleton ensures that AudioContext objects are properly reused
 * and cleaned up, preventing the accumulation of audio resources that
 * was causing 100% CPU usage in Obsidian 1.9.X
 */
export class AudioContextManager {
	private static instance: AudioContextManager | null = null;
	private context: AudioContext | null = null;
	private refCount: number = 0;

	private constructor() {}

	static getInstance(): AudioContextManager {
		if (!AudioContextManager.instance) {
			AudioContextManager.instance = new AudioContextManager();
		}
		return AudioContextManager.instance;
	}

	async getContext(): Promise<AudioContext> {
		if (!this.context || this.context.state === 'closed') {
			this.context = new AudioContext();
		}
		this.refCount++;
		return this.context;
	}

	async releaseContext(): Promise<void> {
		this.refCount--;
		if (this.refCount <= 0 && this.context && this.context.state !== 'closed') {
			await this.context.close();
			this.context = null;
			this.refCount = 0;
		}
	}

	async forceClose(): Promise<void> {
		if (this.context && this.context.state !== 'closed') {
			await this.context.close();
		}
		this.context = null;
		this.refCount = 0;
	}

	/**
	 * Safely executes a function with an AudioContext and ensures cleanup
	 */
	async withContext<T>(callback: (ctx: AudioContext) => Promise<T>): Promise<T> {
		const ctx = await this.getContext();
		try {
			return await callback(ctx);
		} finally {
			await this.releaseContext();
		}
	}
}