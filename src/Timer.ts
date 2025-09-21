export class Timer {
	private startTime = 0;
	private elapsedTime = 0;
	private timerInterval: NodeJS.Timeout | null = null;
	private onUpdate: (() => void) | null = null;
	private isPaused = false;
	private pausedTime = 0;

	setOnUpdate(callback: (() => void) | null): void {
		this.onUpdate = callback;
	}

	start(): void {
		if (!this.timerInterval) {
			this.startTime = Date.now() - this.elapsedTime;
			this.timerInterval = setInterval(() => {
				if (!this.isPaused) {
					this.elapsedTime = Date.now() - this.startTime;
					if (this.onUpdate) {
						this.onUpdate();
					}
				}
			}, 1000); // Update once per second instead of 100x per second
		}
	}

	pause(): void {
		this.isPaused = true;
		this.pausedTime = this.elapsedTime;
	}

	resume(): void {
		if (this.isPaused) {
			this.isPaused = false;
			this.startTime = Date.now() - this.pausedTime;
		}
	}

	reset(): void {
		if (this.timerInterval) {
			clearInterval(this.timerInterval);
			this.timerInterval = null;
		}
		this.startTime = 0;
		this.elapsedTime = 0;
		this.isPaused = false;
		this.pausedTime = 0;
		if (this.onUpdate) {
			this.onUpdate();
		}
	}

	getDisplay(): string {
		const totalSeconds = Math.floor(this.elapsedTime / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
	}

	getFormattedTime(): string {
		const seconds = Math.floor(this.elapsedTime / 1000) % 60;
		const minutes = Math.floor(this.elapsedTime / 1000 / 60) % 60;
		const hours = Math.floor(this.elapsedTime / 1000 / 60 / 60);

		const pad = (n: number) => (n < 10 ? "0" + n : n);

		return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
	}
}
