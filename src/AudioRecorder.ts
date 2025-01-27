import { Notice } from "obsidian";
import Whisper from "main";

export interface AudioRecorder {
	startRecording(): Promise<void>;
	pauseRecording(): Promise<void>;
	stopRecording(): Promise<Blob>;
}

function getSupportedMimeType(): string | undefined {
	const mimeTypes = ["audio/mp3", "audio/mp4", "audio/webm", "audio/ogg"];

	for (const mimeType of mimeTypes) {
		if (MediaRecorder.isTypeSupported(mimeType)) {
			return mimeType;
		}
	}

	return undefined;
}

export class NativeAudioRecorder implements AudioRecorder {
	private chunks: BlobPart[] = [];
	private recorder: MediaRecorder | null = null;
	private mimeType: string | undefined;
	private plugin: Whisper;

	constructor(plugin: Whisper) {
		this.plugin = plugin;
		this.chunks = [];
		this.recorder = null;
	}

	/**
	 * Minimal AudioContext-based silence removal.
	 * - Decodes the Blob into a Float32 PCM array.
	 * - Finds where amplitude is above a threshold.
	 * - Trims leading and trailing silence.
	 * - Re-encodes trimmed buffer as WAV.
	 */
	private async removeSilence(inputBlob: Blob): Promise<Blob> {
		if (!this.plugin.settings.useSilenceRemoval) {
			if (this.plugin.settings.debugMode) {
				console.log("Silence removal disabled, returning original audio");
			}
			return inputBlob;
		}

		try {
			const audioCtx = new AudioContext();
			const arrayBuffer = await inputBlob.arrayBuffer();
			const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer); 
			const threshold = Math.pow(10, this.plugin.settings.silenceThreshold / 20);
			const inputData = audioBuffer.getChannelData(0);

			// Log audio statistics
			let maxDb = -Infinity;
			let minDb = Infinity;
			let sumDb = 0;
			let samplesAboveThreshold = 0;

			for (let i = 0; i < inputData.length; i++) {
				const amplitude = Math.abs(inputData[i]);
				if (amplitude > 0) {
					const db = 20 * Math.log10(amplitude);
					maxDb = Math.max(maxDb, db);
					minDb = Math.min(minDb, db);
					sumDb += db;
					if (amplitude > threshold) {
						samplesAboveThreshold++;
					}
				}
			}

			console.log(`Audio Statistics:
				Threshold: ${this.plugin.settings.silenceThreshold} dB
				Max Level: ${maxDb.toFixed(2)} dB
				Min Level: ${minDb.toFixed(2)} dB
				Avg Level: ${(sumDb / inputData.length).toFixed(2)} dB
				Samples Above Threshold: ${samplesAboveThreshold} of ${inputData.length}
				(${((samplesAboveThreshold/inputData.length)*100).toFixed(2)}%)`);

			if (this.plugin.settings.silenceRemoveAll) {
				// Remove all silent segments
				const minSilenceSamples = this.plugin.settings.silenceDuration * audioBuffer.sampleRate;
				const shortSilenceSamples = Math.floor(0.5 * audioBuffer.sampleRate); // 0.5 seconds of silence
				const segments: {start: number, end: number, isSilence: boolean}[] = [];
				let isInSilence = true;
				let silenceStart = 0;
				let nonSilenceStart = 0;

				// Find all segments (both silent and non-silent)
				for (let i = 0; i < inputData.length; i++) {
					if (isInSilence) {
						if (Math.abs(inputData[i]) > threshold) {
							if (i - silenceStart >= minSilenceSamples) {
								// Long enough silence, add it as a silence segment
								segments.push({start: silenceStart, end: i, isSilence: true});
							}
							nonSilenceStart = i;
							isInSilence = false;
						}
					} else {
						if (Math.abs(inputData[i]) <= threshold) {
							silenceStart = i;
							if (nonSilenceStart < silenceStart) {
								segments.push({start: nonSilenceStart, end: silenceStart, isSilence: false});
							}
							isInSilence = true;
						}
					}
				}

				// Add final segment
				if (!isInSilence && nonSilenceStart < inputData.length) {
					segments.push({start: nonSilenceStart, end: inputData.length, isSilence: false});
				} else if (isInSilence && silenceStart < inputData.length) {
					segments.push({start: silenceStart, end: inputData.length, isSilence: true});
				}

				// Calculate total length (non-silent segments + 0.5s per silence)
				const totalLength = segments.reduce((sum, seg) => 
					sum + (seg.isSilence ? shortSilenceSamples : (seg.end - seg.start)), 0);

				if (totalLength === 0) {
					console.log("Audio is all silence or below threshold.");
					return inputBlob;
				}

				// Create new buffer with compressed silence
				const trimmedBuffer = audioCtx.createBuffer(
					audioBuffer.numberOfChannels,
					totalLength,
					audioBuffer.sampleRate
				);

				// Copy segments with compressed silence
				for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
					const channelData = new Float32Array(totalLength);
					let writePos = 0;
					
					for (const segment of segments) {
						if (segment.isSilence) {
							// Fill with 0.5s of silence
							for (let i = 0; i < shortSilenceSamples; i++) {
								channelData[writePos + i] = 0;
							}
							writePos += shortSilenceSamples;
						} else {
							// Copy non-silent segment as is
							const segmentData = audioBuffer.getChannelData(ch).slice(segment.start, segment.end);
							channelData.set(segmentData, writePos);
							writePos += segmentData.length;
						}
					}
					
					trimmedBuffer.copyToChannel(channelData, ch, 0);
				}

				const originalDuration = audioBuffer.length / audioBuffer.sampleRate;
				const newDuration = totalLength / audioBuffer.sampleRate;
				console.log(`Compressed silence in audio from ${originalDuration.toFixed(1)}s to ${newDuration.toFixed(1)}s`);
				new Notice(`Compressed ${segments.filter(s => s.isSilence).length} silence segments from ${originalDuration.toFixed(1)}s to ${newDuration.toFixed(1)}s`);

				return await this.encodeWAV(trimmedBuffer);

			} else {
				// Original behavior: only remove leading/trailing silence
				let startIndex = 0;
				let endIndex = audioBuffer.length - 1;

				while (startIndex < audioBuffer.length) {
					if (Math.abs(inputData[startIndex]) > threshold) {
						console.log(`Found start of audio at ${startIndex} samples (${(startIndex/audioBuffer.sampleRate).toFixed(2)}s)`);
						break;
					}
					startIndex++;
				}

				while (endIndex > startIndex) {
					if (Math.abs(inputData[endIndex]) > threshold) {
						console.log(`Found end of audio at ${endIndex} samples (${(endIndex/audioBuffer.sampleRate).toFixed(2)}s)`);
						break;
					}
					endIndex--;
				}

				if (startIndex >= endIndex) {
					console.log("Audio is all silence or below threshold.");
					return inputBlob;
				}

				const trimmedLength = endIndex - startIndex + 1;
				const trimmedBuffer = audioCtx.createBuffer(
					audioBuffer.numberOfChannels,
					trimmedLength,
					audioBuffer.sampleRate
				);

				for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
					const channelData = audioBuffer.getChannelData(ch).slice(startIndex, endIndex + 1);
					trimmedBuffer.copyToChannel(channelData, ch, 0);
				}

				const removedSeconds = (audioBuffer.length - trimmedLength) / audioBuffer.sampleRate;
				console.log(`Removed ${removedSeconds.toFixed(1)} seconds of leading/trailing silence`);
				new Notice(`Removed ${removedSeconds.toFixed(1)} seconds of leading/trailing silence`);

				return await this.encodeWAV(trimmedBuffer);
			}

		} catch (error) {
			console.error("AudioContext processing error:", error);
			new Notice("Error processing audio: " + error);
			return inputBlob;
		}
	}

	getRecordingState(): "inactive" | "recording" | "paused" | undefined {
		return this.recorder?.state;
	}

	getMimeType(): string | undefined {
		return this.mimeType;
	}

	async startRecording(): Promise<void> {
		if (!this.recorder) {
			try {
				const stream = await navigator.mediaDevices.getUserMedia({
					audio: true,
				});
				this.mimeType = getSupportedMimeType();

				if (!this.mimeType) {
					throw new Error("No supported mimeType found");
				}

				const options = { mimeType: this.mimeType };
				const recorder = new MediaRecorder(stream, options);

				recorder.addEventListener("dataavailable", (e: BlobEvent) => {
					console.log("dataavailable", e.data.size);
					this.chunks.push(e.data);
				});

				this.recorder = recorder;
			} catch (err) {
				new Notice("Error initializing recorder: " + err);
				console.error("Error initializing recorder:", err);
				return;
			}
		}

		this.recorder.start(100);
	}

	async pauseRecording(): Promise<void> {
		if (!this.recorder) {
			return;
		}

		if (this.recorder.state === "recording") {
			this.recorder.pause();
		} else if (this.recorder.state === "paused") {
			this.recorder.resume();
		}
	}

	async stopRecording(): Promise<Blob> {
		return new Promise((resolve) => {
			if (!this.recorder || this.recorder.state === "inactive") {
				const blob = new Blob(this.chunks, { type: this.mimeType });
				this.chunks.length = 0;
				this.removeSilence(blob).then(resolve);
			} else {
				this.recorder.addEventListener(
					"stop",
					async () => {
						const blob = new Blob(this.chunks, {
							type: this.mimeType,
						});
						this.chunks.length = 0;

						if (this.recorder) {
							this.recorder.stream
								.getTracks()
								.forEach((track) => track.stop());
							this.recorder = null;
						}

						const processedBlob = await this.removeSilence(blob);
						resolve(processedBlob);
					},
					{ once: true }
				);

				this.recorder.stop();
			}
		});
	}

	/**
	 * Utility: Re-encode an AudioBuffer as a 16-bit .wav Blob.
	 * Because we're not using ffmpeg, we'll produce a basic WAV format.
	 * If you need MP3, you'd have to add a separate encoder library.
	 */
	private async encodeWAV(buffer: AudioBuffer): Promise<Blob> {
		// Adapted from typical "write WAV header" snippet
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
}
