import Whisper from "main";
import { ButtonComponent, Modal, Setting } from "obsidian";
import { RecordingStatus } from "./StatusBar";
import { generateTimestampedFileName } from "./utils";

export class Controls extends Modal {
	private plugin: Whisper;
	private startButton: ButtonComponent;
	private pauseButton: ButtonComponent;
	private stopButton: ButtonComponent;
	private timerDisplay: HTMLElement;
	private dropdownHandler: ((e: Event) => void) | null = null;
	private customInputHandler: ((e: Event) => void) | null = null;
	private dropdownElement: HTMLSelectElement | null = null;
	private customInputElement: HTMLInputElement | null = null;

	constructor(plugin: Whisper) {
		super(plugin.app);
		this.plugin = plugin;
		this.containerEl.addClass("recording-controls");

		// Set onUpdate callback for the timer
		this.plugin.timer.setOnUpdate(() => {
			this.updateTimerDisplay();
		});
	}

	async startRecording() {
		console.log("start");
		this.plugin.statusBar.updateStatus(RecordingStatus.Recording);
		await this.plugin.recorder.startRecording();
		this.plugin.timer.start();
		this.resetGUI();
	}

	async pauseRecording() {
		console.log("pausing recording...");
		const currentState = this.plugin.recorder.getRecordingState();
		
		if (currentState === "recording") {
			await this.plugin.recorder.pauseRecording();
			this.plugin.statusBar.updateStatus(RecordingStatus.Paused);
			this.plugin.timer.pause();
			this.pauseButton.setIcon("play").setTooltip("Resume recording");
		} else if (currentState === "paused") {
			await this.plugin.recorder.pauseRecording();
			this.plugin.statusBar.updateStatus(RecordingStatus.Recording);
			this.plugin.timer.resume();
			this.pauseButton.setIcon("pause").setTooltip("Pause recording");
		}
	}

	async stopRecording() {
		console.log("stopping recording...");
		this.plugin.statusBar.updateStatus(RecordingStatus.Processing);
		const blob = await this.plugin.recorder.stopRecording();
		this.plugin.timer.reset();
		this.resetGUI();

		const extension = this.plugin.recorder.getMimeType()?.split("/")[1];
		const fileName = generateTimestampedFileName(extension);
		
		await this.plugin.audioHandler.processAudioChunks(blob, fileName);
		this.plugin.statusBar.updateStatus(RecordingStatus.Idle);
		this.updateTimerDisplay();
	}

	updateTimerDisplay() {
		if (this.timerDisplay) {
			this.timerDisplay.textContent = this.plugin.timer.getDisplay();
		}
	}

	resetGUI() {
		const status = this.plugin.statusBar.status;
		
		// Update button states based on recording status
		this.startButton.setDisabled(status === RecordingStatus.Recording || status === RecordingStatus.Paused);
		this.pauseButton.setDisabled(status !== RecordingStatus.Recording && status !== RecordingStatus.Paused);
		this.stopButton.setDisabled(status !== RecordingStatus.Recording && status !== RecordingStatus.Paused);
		
		// Reset pause button icon if needed
		if (status === RecordingStatus.Recording) {
			this.pauseButton.setIcon("pause").setTooltip("Pause recording");
		} else if (status === RecordingStatus.Paused) {
			this.pauseButton.setIcon("play").setTooltip("Resume recording");
		}
	}

	onOpen() {
		const { contentEl } = this;

		// Timer display
		this.timerDisplay = contentEl.createEl("div", {
			cls: "recording-timer",
			text: "00:00",
		});

		// Create button container
		const buttonContainer = contentEl.createEl("div", {
			cls: "recording-controls-buttons",
		});

		// Start button
		this.startButton = new ButtonComponent(buttonContainer)
			.setIcon("play")
			.setTooltip("Start recording")
			.onClick(async () => {
				await this.startRecording();
			});

		// Pause button
		this.pauseButton = new ButtonComponent(buttonContainer)
			.setIcon("pause")
			.setTooltip("Pause recording")
			.setDisabled(true)
			.onClick(async () => {
				await this.pauseRecording();
			});

		// Stop button
		this.stopButton = new ButtonComponent(buttonContainer)
			.setIcon("stop")
			.setTooltip("Stop recording")
			.setDisabled(true)
			.onClick(async () => {
				await this.stopRecording();
			});

		// Add language selector below the controls
		const languageSetting = new Setting(contentEl)
			.setName("Language")
			.setDesc("Select or enter the language for transcription");

		// Create a container for the dropdown and input
		const languageContainer = languageSetting.controlEl.createDiv();
		languageContainer.style.display = "flex";
		languageContainer.style.gap = "10px";
		languageContainer.style.alignItems = "center";

		// Add dropdown for common languages
		const dropdown = languageContainer.createEl("select");
		const commonLanguages = [
			{ value: "", label: "Choose language..." },
			{ value: "en", label: "English" },
			{ value: "es", label: "Spanish" },
			{ value: "fr", label: "French" },
			{ value: "de", label: "German" },
			{ value: "zh", label: "Chinese" },
		];

		commonLanguages.forEach(lang => {
			const option = dropdown.createEl("option");
			option.value = lang.value;
			option.text = lang.label;
		});

		// Set initial value
		dropdown.value = commonLanguages.find(lang => 
			lang.value === this.plugin.settings.language
		)?.value || "";

		// Add text input for custom language
		const customInput = languageContainer.createEl("input", {
			type: "text",
			placeholder: "Custom language code",
		});
		customInput.style.display = dropdown.value === "" ? "block" : "none";
		customInput.value = commonLanguages.some(lang => 
			lang.value === this.plugin.settings.language
		) ? "" : this.plugin.settings.language;

		// Store references for cleanup
		this.dropdownElement = dropdown;
		this.dropdownHandler = async () => {
			const selectedValue = dropdown.value;
			customInput.style.display = selectedValue === "" ? "block" : "none";

			if (selectedValue !== "") {
				this.plugin.settings.language = selectedValue;
				await this.plugin.settingsManager.saveSettings(this.plugin.settings);
			}
		};
		dropdown.addEventListener("change", this.dropdownHandler);

		// Store references for cleanup
		this.customInputElement = customInput;
		this.customInputHandler = async () => {
			if (customInput.value) {
				this.plugin.settings.language = customInput.value;
				await this.plugin.settingsManager.saveSettings(this.plugin.settings);
			}
		};
		customInput.addEventListener("change", this.customInputHandler);

		this.resetGUI();
	}

	onClose() {
		// Clean up event listeners to prevent memory leaks
		if (this.dropdownElement && this.dropdownHandler) {
			this.dropdownElement.removeEventListener("change", this.dropdownHandler);
		}
		if (this.customInputElement && this.customInputHandler) {
			this.customInputElement.removeEventListener("change", this.customInputHandler);
		}

		// Clean up timer callback to prevent updates when modal is closed
		this.plugin.timer.setOnUpdate(null);

		// Call parent onClose
		super.onClose();
	}
}
