import Whisper from "main";
import { App, PluginSettingTab, Setting, TFolder } from "obsidian";
import { SettingsManager } from "./SettingsManager";

export class WhisperSettingsTab extends PluginSettingTab {
	private plugin: Whisper;
	private settingsManager: SettingsManager;
	private createNewFileInput: Setting;
	private saveAudioFileInput: Setting;

	constructor(app: App, plugin: Whisper) {
		super(app, plugin);
		this.plugin = plugin;
		this.settingsManager = plugin.settingsManager;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		
		// Add new API Keys header
		this.containerEl.createEl("h2", { text: "API Keys" });
		this.createApiKeySettings();
		
		// Add transcription service settings
		containerEl.createEl('h3', { text: 'Transcription Service Settings' });

		new Setting(containerEl)
			.setName('Transcription Service')
			.setDesc('Choose which service to use for transcription')
			.addDropdown(dropdown => {
				dropdown
					.addOption('whisper', 'Whisper')
					.addOption('assemblyai', 'AssemblyAI')
					.setValue(this.plugin.settings.transcriptionService)
					.onChange(async (value: "whisper" | "assemblyai") => {
						this.plugin.settings.transcriptionService = value;
						await this.settingsManager.saveSettings(this.plugin.settings);
						this.display();
					});
			});

		new Setting(containerEl)
			.setName('Prompt')
			.setDesc('Words or phrases to help with transcription accuracy (comma-separated). For Whisper, this helps with correct spellings. For AssemblyAI, this boosts recognition of these terms.')
			.addTextArea(text => text
				.setPlaceholder('Enter words or phrases separated by commas')
				.setValue(this.plugin.settings.prompt)
				.onChange(async (value) => {
					this.plugin.settings.prompt = value;
					await this.settingsManager.saveSettings(this.plugin.settings);
				}));

		// Create containers for each service's settings
		const whisperContainer = containerEl.createDiv();
		const assemblyAIContainer = containerEl.createDiv();

		// Show/hide based on selected service
		whisperContainer.style.display = this.plugin.settings.transcriptionService === "whisper" ? "block" : "none";
		assemblyAIContainer.style.display = this.plugin.settings.transcriptionService === "assemblyai" ? "block" : "none";

		// Whisper Settings
		if (this.plugin.settings.transcriptionService === "whisper") {
			whisperContainer.createEl("h2", { text: "Whisper Settings" });
			this.createApiUrlSetting(whisperContainer);
			this.createModelSetting(whisperContainer);
			this.createLanguageSetting(whisperContainer);
		}

		// AssemblyAI Settings
		if (this.plugin.settings.transcriptionService === "assemblyai") {
			assemblyAIContainer.createEl("h2", { text: "AssemblyAI Settings" });
			
			new Setting(assemblyAIContainer)
				.setName("Model")
				.setDesc("Choose which model to use for transcription")
				.addDropdown(dropdown => {
					dropdown
						.addOption("best", "Best Tier")
						.addOption("nano", "Nano")
						.setValue(this.plugin.settings.assemblyAiModel || "best")
						.onChange(async (value: "best" | "nano") => {
							this.plugin.settings.assemblyAiModel = value;
							await this.settingsManager.saveSettings(this.plugin.settings);
						});
				});

			new Setting(assemblyAIContainer)
				.setName("Word Boost Weight")
				.setDesc("Control how much weight to apply to the boosted words/phrases")
				.addDropdown(dropdown => {
					dropdown
						.addOption("low", "Low")
						.addOption("default", "Default")
						.addOption("high", "High")
						.setValue(this.plugin.settings.boostParam)
						.onChange(async (value: "low" | "default" | "high") => {
							this.plugin.settings.boostParam = value;
							await this.settingsManager.saveSettings(this.plugin.settings);
						});
				});

			// AssemblyAI API Key
			new Setting(assemblyAIContainer)
				.setName("AssemblyAI API Key")
				.setDesc("Enter your AssemblyAI API key")
				.addText(text => text
					.setPlaceholder("Enter your AssemblyAI API key")
					.setValue(this.plugin.settings.assemblyAiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.assemblyAiApiKey = value;
						await this.settingsManager.saveSettings(this.plugin.settings);
					}));

			// Speaker Diarization Toggle
			new Setting(assemblyAIContainer)
				.setName("Enable Speaker Diarization")
				.setDesc("Identify and label different speakers in the transcription")
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.useSpeakerDiarization)
					.onChange(async (value) => {
						this.plugin.settings.useSpeakerDiarization = value;
						await this.settingsManager.saveSettings(this.plugin.settings);
						// Force refresh to update speaker count visibility
						this.display();
					}));

			// Speaker Count (only shown if diarization is enabled)
			if (this.plugin.settings.useSpeakerDiarization) {
				new Setting(assemblyAIContainer)
					.setName("Expected Speaker Count")
					.setDesc("Optional: Specify the expected number of speakers (leave empty for automatic detection)")
					.addText(text => text
						.setPlaceholder("e.g., 2")
						.setValue(this.plugin.settings.speakerCount?.toString() ?? "")
						.onChange(async (value) => {
							const numValue = value ? parseInt(value) : undefined;
							this.plugin.settings.speakerCount = numValue;
							await this.settingsManager.saveSettings(this.plugin.settings);
						}));
			}
		}

		// Common Settings (always visible)
		this.containerEl.createEl("h2", { text: "File Settings" });
		this.createSaveAudioFileToggleSetting();
		this.createSaveAudioFilePathSetting();
		this.createNewFileToggleSetting();
		this.createNewFilePathSetting();
		this.createDebugModeToggleSetting();

		// Post-processing settings
		containerEl.createEl("h3", { text: "Post-processing Settings with OpenAI/Claude" });

		new Setting(containerEl)
			.setName("Use Post-Processing")
			.setDesc("Use AI to clean up and format the transcription, including speaker name mapping for AssemblyAI")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.usePostProcessing)
					.onChange(async (value) => {
						this.plugin.settings.usePostProcessing = value;
						await this.settingsManager.saveSettings(this.plugin.settings);
						// Trigger refresh to show/hide dependent settings
						this.display();
					})
			);

		if (this.plugin.settings.usePostProcessing) {
			new Setting(containerEl)
				.setName("Post-Processing Model")
				.setDesc("Select the model to use for post-processing")
				.addDropdown((dropdown) =>
					dropdown
						.addOption("gpt-4o", "GPT-4o")
						.addOption("gpt-4o-mini", "GPT-4o-mini")
						.addOption("claude-3-5-sonnet-latest", "Claude 3.5 Sonnet")
						.addOption("claude-3-5-haiku-latest", "Claude 3.5 Haiku")
						.setValue(this.plugin.settings.postProcessingModel)
						.onChange(async (value) => {
							this.plugin.settings.postProcessingModel = value;
							await this.settingsManager.saveSettings(this.plugin.settings);
							// Trigger refresh to show/hide API key settings
							this.display();
						})
				);

			const isAnthropicModel = this.plugin.settings.postProcessingModel.startsWith('claude');
			
			if (isAnthropicModel) {
				new Setting(containerEl)
					.setName("Anthropic API Key")
					.setDesc("Your Anthropic API key for Claude models")
					.addText((text) =>
						text
							.setPlaceholder("Enter your Anthropic API key")
							.setValue(this.plugin.settings.anthropicApiKey)
							.onChange(async (value) => {
								this.plugin.settings.anthropicApiKey = value;
								await this.settingsManager.saveSettings(this.plugin.settings);
							})
					);
			} else {
				new Setting(containerEl)
					.setName("OpenAI API Key")
					.setDesc("Your OpenAI API key for GPT models")
					.addText((text) =>
						text
							.setPlaceholder("Enter your OpenAI API key")
							.setValue(this.plugin.settings.openAiApiKey)
							.onChange(async (value) => {
								this.plugin.settings.openAiApiKey = value;
								await this.settingsManager.saveSettings(this.plugin.settings);
							})
					);
			}

			new Setting(containerEl)
				.setName("Post-Processing Prompt")
				.setDesc("The prompt to use for post-processing. For AssemblyAI transcripts, include instructions for mapping speaker labels to names.")
				.addTextArea((text) =>
					text
						.setPlaceholder("Enter your post-processing prompt")
						.setValue(this.plugin.settings.postProcessingPrompt)
						.onChange(async (value) => {
							this.plugin.settings.postProcessingPrompt = value;
							await this.settingsManager.saveSettings(this.plugin.settings);
						})
				);

			// Add setting for keeping original transcription
			new Setting(containerEl)
				.setName("Keep Original Transcription")
				.setDesc("Include the original transcription (before post-processing) in the output file")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.keepOriginalTranscription)
						.onChange(async (value) => {
							this.plugin.settings.keepOriginalTranscription = value;
							await this.settingsManager.saveSettings(this.plugin.settings);
						})
				);
		}

		// Silence removal settings (common for both)
		this.createSilenceRemovalSettings();
	}

	private getUniqueFolders(): TFolder[] {
		const files = this.app.vault.getMarkdownFiles();
		const folderSet = new Set<TFolder>();

		for (const file of files) {
			const parentFolder = file.parent;
			if (parentFolder && parentFolder instanceof TFolder) {
				folderSet.add(parentFolder);
			}
		}

		return Array.from(folderSet);
	}

	private createTextSetting(
		name: string,
		desc: string,
		placeholder: string,
		value: string,
		onChange: (value: string) => Promise<void>
	): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder(placeholder)
					.setValue(value)
					.onChange(async (value) => await onChange(value))
			);
	}

	private createApiKeySettings(): void {
		// Whisper API Key
		this.createTextSetting(
			"Whisper API Key",
			"Enter your API key for Whisper transcription (This can be the same as your OpenAI API key, but could also be a key to the groq-API or Microsoft Azure.)",
			"sk-...xxxx",
			this.plugin.settings.whisperApiKey,
			async (value) => {
				this.plugin.settings.whisperApiKey = value;
				await this.settingsManager.saveSettings(this.plugin.settings);
			}
		);

		// OpenAI API Key
		this.createTextSetting(
			"OpenAI API Key",
			"Enter your OpenAI API key to use GPT models",
			"sk-...xxxx",
			this.plugin.settings.openAiApiKey,
			async (value) => {
				this.plugin.settings.openAiApiKey = value;
				await this.settingsManager.saveSettings(this.plugin.settings);
			}
		);

		// Anthropic API Key
		this.createTextSetting(
			"Anthropic API Key",
			"Enter your Anthropic API key for Claude models",
			"sk-ant-...",
			this.plugin.settings.anthropicApiKey,
			async (value) => {
				this.plugin.settings.anthropicApiKey = value;
				await this.settingsManager.saveSettings(this.plugin.settings);
			}
		);
	}

	private createApiUrlSetting(container = this.containerEl) {
		new Setting(container)
			.setName("API URL")
			.setDesc("Specify the endpoint that will be used to make requests to")
			.addText((text) =>
				text
					.setPlaceholder("https://api.your-custom-url.com")
					.setValue(this.plugin.settings.apiUrl)
					.onChange(async (value) => {
						this.plugin.settings.apiUrl = value;
						await this.settingsManager.saveSettings(this.plugin.settings);
					})
			);
	}

	private createModelSetting(container = this.containerEl) {
		new Setting(container)
			.setName("Model")
			.setDesc("Specify the machine learning model to use for transcribing audio to text")
			.addText((text) =>
				text
					.setPlaceholder("whisper-1")
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value;
						await this.settingsManager.saveSettings(this.plugin.settings);
					})
			);
	}

	private createLanguageSetting(container = this.containerEl) {
		new Setting(container)
			.setName("Language")
			.setDesc("Specify the language of the message being whispered")
			.addText((text) =>
				text
					.setPlaceholder("en")
					.setValue(this.plugin.settings.language)
					.onChange(async (value) => {
						this.plugin.settings.language = value;
						await this.settingsManager.saveSettings(this.plugin.settings);
					})
			);
	}

	private createSaveAudioFileToggleSetting(): void {
		new Setting(this.containerEl)
			.setName("Save recording")
			.setDesc(
				"Turn on to save the audio file after sending it to the Whisper API"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.saveAudioFile)
					.onChange(async (value) => {
						this.plugin.settings.saveAudioFile = value;
						if (!value) {
							this.plugin.settings.saveAudioFilePath = "";
						}
						await this.settingsManager.saveSettings(
							this.plugin.settings
						);
						this.saveAudioFileInput.setDisabled(!value);
					})
			);
	}

	private createSaveAudioFilePathSetting(): void {
		this.saveAudioFileInput = new Setting(this.containerEl)
			.setName("Recordings folder")
			.setDesc(
				"Specify the path in the vault where to save the audio files"
			)
			.addText((text) =>
				text
					.setPlaceholder("Example: folder/audio")
					.setValue(this.plugin.settings.saveAudioFilePath)
					.onChange(async (value) => {
						this.plugin.settings.saveAudioFilePath = value;
						await this.settingsManager.saveSettings(
							this.plugin.settings
						);
					})
			)
			.setDisabled(!this.plugin.settings.saveAudioFile);
	}

	private createNewFileToggleSetting(): void {
		new Setting(this.containerEl)
			.setName("Save transcription")
			.setDesc(
				"Turn on to create a new file for each recording, or leave off to add transcriptions at your cursor"
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.createNewFileAfterRecording)
					.onChange(async (value) => {
						this.plugin.settings.createNewFileAfterRecording =
							value;
						if (!value) {
							this.plugin.settings.createNewFileAfterRecordingPath =
								"";
						}
						await this.settingsManager.saveSettings(
							this.plugin.settings
						);
						this.createNewFileInput.setDisabled(!value);
					});
			});
	}

	private createNewFilePathSetting(): void {
		this.createNewFileInput = new Setting(this.containerEl)
			.setName("Transcriptions folder")
			.setDesc(
				"Specify the path in the vault where to save the transcription files"
			)
			.addText((text) => {
				text.setPlaceholder("Example: folder/note")
					.setValue(
						this.plugin.settings.createNewFileAfterRecordingPath
					)
					.onChange(async (value) => {
						this.plugin.settings.createNewFileAfterRecordingPath =
							value;
						await this.settingsManager.saveSettings(
							this.plugin.settings
						);
					});
			});
	}

	private createDebugModeToggleSetting(): void {
		new Setting(this.containerEl)
			.setName("Debug Mode")
			.setDesc(
				"Turn on to increase the plugin's verbosity for troubleshooting."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.debugMode)
					.onChange(async (value) => {
						this.plugin.settings.debugMode = value;
						await this.settingsManager.saveSettings(
							this.plugin.settings
						);
					});
			});
	}

	private createSilenceRemovalSettings(): void {
		this.containerEl.createEl("h2", { text: "Silence Removal Settings" });

		// Note below the header
		this.containerEl.createEl("p", {
			text: "Note: If Remove Silence is enabled, the final audio will be saved as a WAV file."
		});

		// Toggle to enable/disable silence removal
		new Setting(this.containerEl)
			.setName("Remove Silence")
			.setDesc("Remove silence from audio before processing (final file will be WAV).")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useSilenceRemoval)
				.onChange(async (value) => {
					this.plugin.settings.useSilenceRemoval = value;
					await this.settingsManager.saveSettings(this.plugin.settings);
				}));

		// Silence threshold
		new Setting(this.containerEl)
			.setName("Silence Threshold")
			.setDesc("Sound level (in dB) below which audio is considered silence. Lower values are more aggressive (-50 is default)")
			.addSlider(slider => slider
				.setLimits(-70, -5, 1)
				.setValue(this.plugin.settings.silenceThreshold)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.silenceThreshold = value;
					await this.settingsManager.saveSettings(this.plugin.settings);
				}));

		// Silence duration
		new Setting(this.containerEl)
			.setName("Minimum Silence Duration")
			.setDesc("Minimum duration (in seconds) of silence to remove")
			.addSlider(slider => slider
				.setLimits(0.05, 10.0, 0.1)
				.setValue(this.plugin.settings.silenceDuration)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.silenceDuration = value;
					await this.settingsManager.saveSettings(this.plugin.settings);
				}));

		// Remove all silence periods
		new Setting(this.containerEl)
			.setName("Remove All Silence")
			.setDesc("When enabled, removes all silent periods throughout the audio. When disabled, only removes leading and trailing silence.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.silenceRemoveAll)
				.onChange(async (value) => {
					this.plugin.settings.silenceRemoveAll = value;
					await this.settingsManager.saveSettings(this.plugin.settings);
				}));
	}
}
