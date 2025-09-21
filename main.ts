import { Plugin, Notice } from "obsidian";
import { Timer } from "src/Timer";
import { Controls } from "src/Controls";
import { AudioHandler } from "src/AudioHandler";
import { WhisperSettingsTab } from "src/WhisperSettingsTab";
import { SettingsManager, WhisperSettings } from "src/SettingsManager";
import { NativeAudioRecorder } from "src/AudioRecorder";
import { RecordingStatus, StatusBar } from "src/StatusBar";
import { generateTimestampedFileName } from "src/utils";
import { TempRecordingManager } from "src/TempRecordingManager";
import { AudioContextManager } from "src/AudioContextManager";

export default class Whisper extends Plugin {
	settings: WhisperSettings;
	settingsManager: SettingsManager;
	timer: Timer;
	recorder: NativeAudioRecorder;
	audioHandler: AudioHandler;
	controls: Controls | null = null;
	statusBar: StatusBar;
	tempManager: TempRecordingManager;

	async onload() {
		this.settingsManager = new SettingsManager(this);
		this.settings = await this.settingsManager.loadSettings();

		this.addRibbonIcon("activity", "Open recording controls", (evt) => {
			if (!this.controls) {
				this.controls = new Controls(this);
			}
			this.controls.open();
		});

		this.addSettingTab(new WhisperSettingsTab(this.app, this));

		this.timer = new Timer();
		this.audioHandler = new AudioHandler(this);
		this.tempManager = new TempRecordingManager(this);
		this.recorder = new NativeAudioRecorder(this);

		this.statusBar = new StatusBar(this);

		this.addCommands();

		// Attempt recovery of any previous unsaved recording
		await this.tempManager.promptAndRecoverIfAny(async (blob, fileName) => {
			await this.audioHandler.processAudioChunks(blob, fileName);
		});
	}

	onunload() {
		if (this.controls) {
			this.controls.close();
		}

		this.statusBar.remove();

		// Clean up timer
		this.timer.reset();

		// Force close any lingering AudioContexts
		AudioContextManager.getInstance().forceClose();

		// Clean up temp recordings
		this.tempManager.deleteSession();
	}

	addCommands() {
		this.addCommand({
			id: "start-stop-recording",
			name: "Start/stop recording",
			callback: async () => {
				if (this.statusBar.status !== RecordingStatus.Recording) {
					this.statusBar.updateStatus(RecordingStatus.Recording);
					await this.recorder.startRecording();
				} else {
					this.statusBar.updateStatus(RecordingStatus.Processing);
					const audioBlob = await this.recorder.stopRecording();
					const extension = this.recorder.getMimeType()?.split("/")[1];
					const fileName = generateTimestampedFileName(extension);

					// Changed from sendAudioData to processAudioChunks
					await this.audioHandler.processAudioChunks(audioBlob, fileName);
					this.statusBar.updateStatus(RecordingStatus.Idle);
				}
			},
			hotkeys: [
				{
					modifiers: ["Alt"],
					key: "Q",
				},
			],
		});

		this.addCommand({
			id: "pause-resume-recording",
			name: "Pause/resume recording",
			callback: async () => {
				if (this.statusBar.status === RecordingStatus.Recording) {
					await this.recorder.pauseRecording();
					this.statusBar.updateStatus(RecordingStatus.Paused);
				} else if (this.statusBar.status === RecordingStatus.Paused) {
					await this.recorder.pauseRecording(); // This will resume since it's already paused
					this.statusBar.updateStatus(RecordingStatus.Recording);
				}
			},
			hotkeys: [
				{
					modifiers: ["Alt"],
					key: "W",
				},
			],
		});

		this.addCommand({
			id: "upload-audio-file",
			name: "Upload audio file",
			callback: () => {
				// Create an input element for file selection
				const fileInput = document.createElement("input");
				fileInput.type = "file";
				fileInput.accept = "audio/*"; // Accept only audio files

				// Handle file selection
				fileInput.onchange = async (event) => {
					const files = (event.target as HTMLInputElement).files;
					if (files && files.length > 0) {
						const file = files[0];
						const fileName = file.name;
						await this.audioHandler.processAudioChunks(file, fileName);
					}
				};

				// Programmatically open the file dialog
				fileInput.click();
			},
		});

		// Add new command to delete all transcripts
		this.addCommand({
			id: "delete-all-transcripts",
			name: "Delete all AssemblyAI transcripts",
			callback: async () => {
				if (this.settings.transcriptionService !== "assemblyai") {
					new Notice("This command is only available when using AssemblyAI as the transcription service");
					return;
				}
				await this.audioHandler.deleteAllTranscripts();
			},
		});
	}
}