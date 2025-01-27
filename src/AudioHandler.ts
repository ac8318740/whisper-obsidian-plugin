import axios from "axios";
import { Notice, MarkdownView } from "obsidian";
import { getBaseFileName } from "./utils";
import { RecordingStatus } from "./StatusBar";
import { SpeakerReviewModal, SpeakerReviewResult, SpeakerIdentification } from './SpeakerReviewModal';
import type Whisper from "../main";
import { AssemblyAI, TranscriptListItem } from "assemblyai";
import { Modal, Setting } from "obsidian";
import * as https from 'https';

interface TranscriptWithIdentifications {
	id: string;
	text: string;
	utterances?: Array<{
		speaker: string;
		text: string;
	}>;
	speakerIdentifications?: SpeakerIdentification[];
}

export class AudioHandler {
	private plugin: Whisper;
	private assemblyClient: AssemblyAI | null = null;

	constructor(plugin: Whisper) {
		this.plugin = plugin;
	}

	private initializeAssemblyAI() {
		if (this.plugin.settings.assemblyAiApiKey) {
			try {
				this.assemblyClient = new AssemblyAI({
					apiKey: this.plugin.settings.assemblyAiApiKey
				});
				
				if (this.plugin.settings.debugMode) {
					console.log("AssemblyAI client initialized");
				}
			} catch (error) {
				console.error("Failed to initialize AssemblyAI client:", error);
				new Notice("Failed to initialize AssemblyAI client");
			}
		}
	}

	/**
	 * Processes audio using either Whisper or AssemblyAI based on settings
	 */
	async processAudioChunks(blob: Blob, fileName: string): Promise<void> {
		try {
			if (this.plugin.settings.transcriptionService === "assemblyai") {
				// Show initial speaker count prompt
				const speakerCount = await this.promptForSpeakerCount();
				
				// Re-initialize AssemblyAI client to ensure we have the latest key
				this.initializeAssemblyAI();
				await this.processWithAssemblyAI(blob, speakerCount);
			} else {
				await this.processWithWhisper(blob, fileName);
			}
		} catch (error) {
			// Reset status on error
			if (this.plugin.statusBar) {
				this.plugin.statusBar.updateStatus(RecordingStatus.Idle);
			}
			throw error;
		}
	}

	private async promptForSpeakerCount(): Promise<number | undefined> {
		return new Promise((resolve) => {
			const modal = new Modal(this.plugin.app);
			modal.titleEl.setText('Speaker Count');
			
			const contentEl = modal.contentEl;
			contentEl.createEl('p', { 
				text: 'If you know how many speakers are in this recording, enter the number below. This can help improve speaker detection accuracy. Leave empty if unsure.'
			});

			let speakerCount: number | undefined;
			
			new Setting(contentEl)
				.setName('Number of Speakers')
				.setDesc('Optional: Enter the number of speakers')
				.addText(text => text
					.setPlaceholder('e.g., 2')
					.onChange(value => {
						speakerCount = value ? parseInt(value) : undefined;
					}));

			new Setting(contentEl)
				.addButton(button => button
					.setButtonText('Cancel')
					.onClick(() => {
						modal.close();
						resolve(undefined);
					}))
				.addButton(button => button
					.setButtonText('Continue')
					.setCta()
					.onClick(() => {
						modal.close();
						resolve(speakerCount);
					}));

			modal.open();
		});
	}

	private async promptForDeletionCount(): Promise<{ count?: number; deleteAll: boolean }> {
		return new Promise((resolve) => {
			const modal = new Modal(this.plugin.app);
			modal.titleEl.setText('Delete Transcripts');
			
			const contentEl = modal.contentEl;
			contentEl.createEl('p', { 
				text: 'How many recent transcripts would you like to delete?'
			});

			let transcriptCount: number | undefined;
			let deleteAll = false;
			
			new Setting(contentEl)
				.setName('Number of Transcripts')
				.setDesc('Enter the number of most recent transcripts to delete')
				.addText(text => {
					text.setPlaceholder('e.g., 10')
						.setValue('')
						.setDisabled(false)
						.onChange(value => {
							transcriptCount = value ? parseInt(value) : undefined;
						});
					return text;
				});

			new Setting(contentEl)
				.setName('Delete All')
				.setDesc('Delete all transcripts')
				.addToggle(toggle => {
					toggle.setValue(false)
						.onChange(value => {
							deleteAll = value;
							const textInput = contentEl.querySelector('input[type="text"]') as HTMLInputElement;
							if (textInput) {
								textInput.disabled = value;
								if (value) {
									textInput.value = '';
									transcriptCount = undefined;
								}
							}
						});
				});

			new Setting(contentEl)
				.addButton(button => button
					.setButtonText('Cancel')
					.onClick(() => {
						modal.close();
						resolve({ count: undefined, deleteAll: false });
					}))
				.addButton(button => button
					.setButtonText('Delete')
					.setCta()
					.onClick(() => {
						modal.close();
						resolve({ count: transcriptCount, deleteAll });
					}));

			modal.open();
		});
	}

	/**
	 * Delete a transcript from AssemblyAI
	 * Note: We use Node.js https module directly instead of the AssemblyAI SDK because
	 * the SDK's delete method uses browser's fetch API which triggers CORS preflight checks.
	 * Since we're in Electron (Obsidian), using Node.js https module bypasses these CORS restrictions.
	 */
	private async deleteTranscript(transcriptId: string, reason: string): Promise<void> {
		try {
			if (this.plugin.settings.debugMode) {
				console.log(`Attempting to delete ${reason} transcript:`, transcriptId);
			}
			
			// Reinitialize AssemblyAI client
			this.initializeAssemblyAI();
			if (!this.assemblyClient) {
				throw new Error("Failed to initialize AssemblyAI client for deletion");
			}

			const transcript = await this.assemblyClient.transcripts.get(transcriptId);
			if (transcript?.status === "completed" || transcript?.status === "error") {
				// Use Node.js https module instead of SDK's delete method to avoid CORS issues
				await new Promise<void>((resolve, reject) => {
					const options = {
						hostname: 'api.assemblyai.com',
						port: 443,
						path: `/v2/transcript/${transcriptId}`,
						method: 'DELETE',
						headers: {
							'Authorization': this.plugin.settings.assemblyAiApiKey
						}
					};

					const req = https.request(options, (res) => {
						if (res.statusCode === 200 || res.statusCode === 204) {
							resolve();
						} else {
							reject(new Error(`Failed to delete transcript: ${res.statusCode}`));
						}
					});

					req.on('error', (error: Error) => {
						reject(error);
					});

					req.end();
				});

				if (this.plugin.settings.debugMode) {
					console.log(`Deleted ${reason} transcript:`, transcriptId);
				}
			} else {
				console.log(`Skipping deletion of ${reason} transcript ${transcriptId} as status is: ${transcript?.status}`);
			}
		} catch (deleteError) {
			console.error(`Error deleting ${reason} transcript:`, transcriptId, deleteError);
		}
	}

	/**
	 * Process audio using AssemblyAI
	 */
	private async processWithAssemblyAI(audioData: Blob, initialSpeakerCount?: number): Promise<void> {
		try {
			this.plugin.statusBar.updateStatus(RecordingStatus.Processing);
			
			// Initialize AssemblyAI client if needed
			if (!this.assemblyClient) {
				this.initializeAssemblyAI();
			}

			if (!this.assemblyClient) {
				throw new Error("Failed to initialize AssemblyAI client");
			}

			// Track previous speaker count attempts
			const previousAttempts: number[] = initialSpeakerCount ? [initialSpeakerCount] : [];
			let transcriptResult: TranscriptWithIdentifications | undefined;
			let accepted = false;
			let speakerIdentifications: SpeakerIdentification[] | undefined;

			while (!accepted) {
				if (this.plugin.settings.debugMode) {
					console.log("Starting transcription attempt", {
						previousAttempts,
						currentAttempt: previousAttempts.length + 1
					});
				}

				// Start transcription with current speaker count and word boost
				const params: any = {
					audio: audioData,
					speaker_labels: true,
					speech_model: this.plugin.settings.assemblyAiModel || "best",
					boost_param: this.plugin.settings.boostParam
				};

				// Add word boost if prompt is configured
				if (this.plugin.settings.prompt) {
					// Split the prompt by commas and clean up each term
					const wordBoostTerms = this.plugin.settings.prompt
						.split(',')
						.map(term => term.trim())
						.filter(term => term.length > 0);

					if (this.plugin.settings.debugMode) {
						console.log("Word boost terms:", wordBoostTerms);
						console.log("Word boost terms (stringified):", JSON.stringify(wordBoostTerms));
					}

					params.word_boost = wordBoostTerms;
				}

				// Only include speakers_expected if we have a previous attempt
				if (previousAttempts.length > 0) {
					params.speakers_expected = previousAttempts[previousAttempts.length - 1];
				}

				if (this.plugin.settings.debugMode) {
					console.log("Final params being sent to AssemblyAI:", JSON.stringify(params, null, 2));
				}

				transcriptResult = await this.assemblyClient.transcripts.transcribe(params) as TranscriptWithIdentifications;
				const currentTranscriptId = transcriptResult.id;
				
				if (this.plugin.settings.debugMode) {
					console.log("Received transcription result:", transcriptResult);
				}

				// Extract speaker samples (up to 2 sentences per speaker)
				const speakerSamples = this.extractSpeakerSamples(transcriptResult);

				// Get the active file
				const activeFile = this.plugin.app.workspace.getActiveFile();

				// Show review modal and wait for result
				const reviewResult = await new Promise<SpeakerReviewResult>((resolve) => {
					new SpeakerReviewModal(
						this.plugin.app,
						speakerSamples,
						previousAttempts,
						activeFile,
						resolve
					).open();
				});

				if (this.plugin.settings.debugMode) {
					console.log("Speaker review result:", reviewResult);
				}

				if (reviewResult.accepted) {
					accepted = true;
					speakerIdentifications = reviewResult.speakerIdentifications;
					if (this.plugin.settings.debugMode) {
						console.log("Speaker detection accepted with identifications:", speakerIdentifications);
					}
					
					// Delete the transcript immediately after acceptance
					await this.deleteTranscript(currentTranscriptId, "accepted");
				} else if (reviewResult.speakerCount) {
					previousAttempts.push(reviewResult.speakerCount);
					if (this.plugin.settings.debugMode) {
						console.log("Retrying with new speaker count:", reviewResult.speakerCount);
					}
					// Delete the rejected transcript before trying again
					await this.deleteTranscript(currentTranscriptId, "rejected");
				} else {
					// If we get here, the modal was closed without explicit accept/reject
					accepted = true;
					if (this.plugin.settings.debugMode) {
						console.log("Modal closed without explicit decision, accepting current result");
					}
					// Delete the transcript since we're accepting it
					await this.deleteTranscript(currentTranscriptId, "implicitly accepted");
				}
			}

			// Add speaker identifications to the transcript result
			if (transcriptResult && speakerIdentifications) {
				transcriptResult.speakerIdentifications = speakerIdentifications;
			}

			// Process the accepted transcription
			if (transcriptResult) {
				await this.processTranscriptionResult(transcriptResult);
			}

		} catch (error) {
			console.error('Error in processWithAssemblyAI:', error);
			this.plugin.statusBar.updateStatus(RecordingStatus.Idle);
			new Notice(`Error processing audio: ${error.message}`);
		}
	}

	private extractSpeakerSamples(transcript: any): { speaker: string; text: string; }[] {
		const samples: { speaker: string; text: string; }[] = [];
		const speakerUtterances = new Map<string, string[]>();

		// Group utterances by speaker
		transcript.utterances?.forEach((utterance: any) => {
			if (!speakerUtterances.has(utterance.speaker)) {
				speakerUtterances.set(utterance.speaker, []);
			}
			speakerUtterances.get(utterance.speaker)?.push(utterance.text);
		});

		// Get up to 2 sentences for each speaker
		speakerUtterances.forEach((utterances, speaker) => {
			const text = this.getFirstTwoSentences(utterances.join(' '));
			samples.push({ 
				speaker: `Speaker ${speaker}:`, 
				text 
			});
		});

		if (this.plugin.settings.debugMode) {
			console.log("Extracted speaker samples:", samples);
		}

		return samples;
	}

	private getFirstTwoSentences(text: string): string {
		const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
		return sentences.slice(0, 2).join(' ').trim();
	}

	private async processTranscriptionResult(transcript: any): Promise<void> {
		if (this.plugin.settings.debugMode) {
			console.log("Processing accepted transcription result:", transcript);
		}

		try {
			// Format the transcription
			let noteContent = "# Full Notes\n\n"; // Always start with Full Notes header
			let originalText = "";
			
			if (this.plugin.settings.useSpeakerDiarization && transcript.utterances) {
				if (this.plugin.settings.debugMode) {
					console.log("Processing speaker diarization with utterances:", transcript.utterances);
				}

				// First format with Speaker A, B, etc.
				let currentSpeaker = "";
				for (const utterance of transcript.utterances) {
					if (utterance.speaker !== currentSpeaker) {
						originalText += `\n\n**Speaker ${utterance.speaker}**: `;
						noteContent += `\n\n- Speaker ${utterance.speaker}: `;
						currentSpeaker = utterance.speaker;
					}
					originalText += utterance.text + " ";
					noteContent += utterance.text + " ";
				}

				// Use post-processing to map speaker labels if enabled
				if (this.plugin.settings.usePostProcessing && transcript.speakerIdentifications) {
					if (this.plugin.settings.debugMode) {
						console.log("Starting post-processing for speaker mapping with identifications:", transcript.speakerIdentifications);
					}

					try {
						// Create a mapping guide for the post-processing
						const speakerMappings = transcript.speakerIdentifications
							.map((id: SpeakerIdentification) => {
								// If there's an alias, use that
								if (id.alias) {
									return `${id.speaker} → ${id.alias}`;
								}
								// Otherwise use the selected attendee or manually entered name
								// If no name/attendee selected, keep the full "Speaker X" format
								const displayName = id.selectedAttendee || id.name || id.speaker;
								return `${id.speaker} → ${displayName}`;
							})
							.join('\n');

						// Get the word list from the prompt setting
						const wordList = this.plugin.settings.prompt
							.split(',')
							.map(term => term.trim())
							.filter(term => term.length > 0)
							.join('\n- ');

						// Always put speaker mappings at the start, then the custom prompt
						const mappingHeader = 'Map all speakers to their actual names, based on the below mapping guide. However, ensure you also follow any instructions below.\n\n' +
							'Speaker Mappings:\n' + speakerMappings + '\n\n' +
							'Additionally, you should be on the lookout for words or phrases that may be any of the following, but misspelt. ' +
							'If you see any, please correct the spelling. Use your judgment and the context of the transcription to determine ' +
							'whether the transcription should have returned one of these words. However, ensure you also follow any instructions ' +
							'below (those should supercede this).\n\n' +
							'Words/phrases to be on the lookout for:\n- ' + wordList + '\n\n' +
							'-------------------\n' +
							'NOW, ONTO THE MAIN (AND MOST IMPORTANT) SET OF INSTRUCTIONS:\n' +
							'-------------------\n\n';

						const customPrompt = this.plugin.settings.postProcessingPrompt || 
							'Replace the speaker labels with their actual names while preserving the formatting.';
						const postProcessPrompt = mappingHeader + customPrompt;

						if (this.plugin.settings.debugMode) {
							console.log("Post-processing with prompt:", postProcessPrompt);
						}

						const isAnthropicModel = this.plugin.settings.postProcessingModel.startsWith('claude');
						let postProcessResponse;

						if (isAnthropicModel) {
							if (!this.plugin.settings.anthropicApiKey) {
								throw new Error("Anthropic API key is required for Claude models");
							}

							postProcessResponse = await axios.post(
								"https://api.anthropic.com/v1/messages",
								{
									model: this.plugin.settings.postProcessingModel,
									max_tokens: 8190,
									messages: [
										{
											role: "user",
											content: postProcessPrompt + "\n\n" + noteContent.replace("# Full Notes\n\n", "")
										}
									]
								},
								{
									headers: {
										"Content-Type": "application/json",
										"x-api-key": this.plugin.settings.anthropicApiKey,
										"anthropic-version": "2023-06-01",
										"anthropic-dangerous-direct-browser-access": "true"
									}
								}
							);
							noteContent = "# Full Notes\n\n" + postProcessResponse.data.content[0].text;
						} else {
							postProcessResponse = await axios.post(
								"https://api.openai.com/v1/chat/completions",
								{
									model: this.plugin.settings.postProcessingModel,
									messages: [
										{
											role: "system",
											content: postProcessPrompt,
										},
										{
											role: "user",
											content: noteContent.replace("# Full Notes\n\n", ""),
										},
									],
									temperature: 0.7,
								},
								{
									headers: {
										"Content-Type": "application/json",
										Authorization: `Bearer ${this.plugin.settings.openAiApiKey}`,
									},
								}
							);
							noteContent = "# Full Notes\n\n" + postProcessResponse.data.choices[0].message.content.trim();
						}

						if (this.plugin.settings.debugMode) {
							console.log("Post-processing complete");
						}
					} catch (postErr: any) {
						console.error("Error during post-processing:", postErr);
						new Notice("Error during post-processing: " + postErr.message);
					}
				}
			} else {
				// Simple transcription without speaker diarization
				originalText = transcript.text || "";
				const transcriptionText = transcript.text || "";
				noteContent += transcriptionText;
			}

			// Add original transcription if enabled
			if (this.plugin.settings.keepOriginalTranscription && originalText !== noteContent) {
				noteContent += "\n\n# Raw Notes\n" + originalText;
			}

			// Save or insert the transcription
			const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
			const shouldCreateNewFile = this.plugin.settings.createNewFileAfterRecording || !activeView;

			if (shouldCreateNewFile) {
				const now = new Date();
				const fileName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}.md`;
				const filePath = `${
					this.plugin.settings.createNewFileAfterRecordingPath
						? `${this.plugin.settings.createNewFileAfterRecordingPath}/`
						: ""
				}${fileName}`;

				await this.plugin.app.vault.create(filePath, noteContent);
				await this.plugin.app.workspace.openLinkText(filePath, "", true);
				new Notice(`Transcription saved to ${filePath}`);
			} else {
				const editor = activeView?.editor;
				if (editor) {
					const cursorPosition = editor.getCursor();
					editor.replaceRange(noteContent, cursorPosition);
					const noteLines = noteContent.split("\n");
					const newPosition = {
						line: cursorPosition.line + noteLines.length - 1,
						ch: noteLines[noteLines.length - 1].length,
					};
					editor.setCursor(newPosition);
					new Notice("Transcription inserted at cursor");
				}
			}

			// Reset status
			this.plugin.statusBar.updateStatus(RecordingStatus.Idle);

		} catch (error) {
			console.error("Error processing transcription result:", error);
			this.plugin.statusBar.updateStatus(RecordingStatus.Idle);
			new Notice(`Error processing transcription: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Process audio using Whisper (existing chunked implementation)
	 */
	private async processWithWhisper(blob: Blob, fileName: string): Promise<void> {
		const chunkSize = 25 * 1024 * 1024; // 25 MB
		const numChunks = Math.ceil(blob.size / chunkSize);
		let completeTranscription = "";
		let completeOriginalText = "";
		let finalTitle: string | null = null;

		// Set initial file paths
		const baseFileName = getBaseFileName(fileName);
		let audioFilePath = `${
			this.plugin.settings.saveAudioFilePath
				? `${this.plugin.settings.saveAudioFilePath}/`
				: ""
		}${fileName}`;
		let noteFilePath = `${
			this.plugin.settings.createNewFileAfterRecordingPath
				? `${this.plugin.settings.createNewFileAfterRecordingPath}/`
				: ""
		}${baseFileName}.md`;

		if (this.plugin.settings.debugMode) {
			console.log("Base filename:", baseFileName);
			console.log("Audio file path:", audioFilePath);
			console.log("Note file path:", noteFilePath);
			console.log("Settings:", this.plugin.settings);
		}

		// Process each chunk
		for (let i = 0; i < numChunks; i++) {
			const start = i * chunkSize;
			const end = Math.min(start + chunkSize, blob.size);
			const audioChunk = blob.slice(start, end);
			const chunkFileName = `${fileName}_chunk_${i}`;

			if (this.plugin.settings.debugMode) {
				console.log(`Processing chunk ${i + 1}/${numChunks}: ${chunkFileName}`);
			}

			try {
				// Save audio chunk if setting is enabled
				if (this.plugin.settings.saveAudioFile) {
					try {
						const arrayBuffer = await audioChunk.arrayBuffer();
						await this.plugin.app.vault.adapter.writeBinary(
							audioFilePath,
							new Uint8Array(arrayBuffer)
						);
						new Notice("Audio chunk saved successfully.");
					} catch (err: any) {
						console.error("Error saving audio chunk:", err);
						new Notice("Error saving audio chunk: " + err.message);
					}
				}

				// Send the chunk for transcription
				const { transcription, originalText } = await this.sendAudioData(audioChunk, chunkFileName);
				completeTranscription += transcription + "\n";
				completeOriginalText += originalText + "\n";

				// Generate title after first chunk if enabled
				if (i === 0 && this.plugin.settings.autoGenerateTitle && this.plugin.settings.titleGenerationPrompt) {
					finalTitle = await this.generateTitle(transcription);
					if (finalTitle) {
						// Update file paths with title
						const nowFileName = `${finalTitle} - ${fileName}`;
						const nowBaseFileName = getBaseFileName(nowFileName);

						const newAudioFilePath = `${
							this.plugin.settings.saveAudioFilePath
								? `${this.plugin.settings.saveAudioFilePath}/`
								: ""
						}${nowFileName}`;

						// Rename audio file if it was saved
						if (this.plugin.settings.saveAudioFile) {
							await this.plugin.app.vault.adapter.rename(
								audioFilePath,
								newAudioFilePath
							);
						}
						audioFilePath = newAudioFilePath;

						noteFilePath = `${
							this.plugin.settings.createNewFileAfterRecordingPath
								? `${this.plugin.settings.createNewFileAfterRecordingPath}/`
								: ""
						}${nowBaseFileName}.md`;
					}
				}
			} catch (err) {
				console.error(`Error processing chunk ${i + 1}/${numChunks}:`, err);
				new Notice(`Error processing chunk ${i + 1}: ${err.message}`);
			}
		}

		// After processing chunks
		if (this.plugin.settings.debugMode) {
			console.log("Complete transcription length:", completeTranscription.length);
			console.log("Original text length:", completeOriginalText.length);
			console.log("Final title:", finalTitle);
		}

		// Create final note content
		let noteContent = "";
		if (finalTitle && finalTitle.trim() !== "") {
			noteContent = `# ${finalTitle}\n\n`;
			if (this.plugin.settings.saveAudioFile) {
				noteContent += `![[${audioFilePath}]]\n\n`;
			}
		} else if (this.plugin.settings.saveAudioFile) {
			noteContent = `![[${audioFilePath}]]\n\n`;
		}
		
		noteContent += "# Full Notes\n\n" + completeTranscription;

		// Add original transcription if enabled
		if (this.plugin.settings.keepOriginalTranscription && completeOriginalText !== completeTranscription) {
			noteContent += "\n\n# Raw Notes\n" + completeOriginalText;
		}

		// Save or insert the transcription
		const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		const shouldCreateNewFile = this.plugin.settings.createNewFileAfterRecording || !activeView;

		try {
			if (shouldCreateNewFile) {
				if (this.plugin.settings.debugMode) {
					console.log("Creating new file:", noteFilePath);
					console.log("Content length:", noteContent.length);
				}
				
				if (!noteContent || noteContent.trim() === "") {
					throw new Error("No content to save");
				}
				
				await this.plugin.app.vault.create(noteFilePath, noteContent);
				await this.plugin.app.workspace.openLinkText(noteFilePath, "", true);
				new Notice(`Transcription saved to ${noteFilePath}`);
			} else {
				const editor = activeView?.editor;
				if (editor) {
					const cursorPosition = editor.getCursor();
					editor.replaceRange(noteContent, cursorPosition);
					const noteLines = noteContent.split("\n");
					const newPosition = {
						line: cursorPosition.line + noteLines.length - 1,
						ch: noteLines[noteLines.length - 1].length,
					};
					editor.setCursor(newPosition);
					new Notice("Transcription inserted at cursor");
				}
			}
		} catch (error) {
			console.error("Error in processAudioChunks:", error);
			new Notice(`Error processing audio: ${error.message}`);
			throw error; // Re-throw to see the full stack trace
		}
	}

	private async generateTitle(text: string): Promise<string | null> {
		if (this.plugin.settings.debugMode) {
			new Notice("Generating title...");
		}
		try {
			let titleResponse;
			const isAnthropicModel = this.plugin.settings.postProcessingModel.startsWith('claude');

			if (isAnthropicModel) {
				if (!this.plugin.settings.anthropicApiKey) {
					throw new Error("Anthropic API key is required for Claude models");
				}

				titleResponse = await axios.post(
					"https://api.anthropic.com/v1/messages",
					{
						model: this.plugin.settings.postProcessingModel,
						max_tokens: 1000,
						messages: [
							{
								role: "user",
								content: this.plugin.settings.titleGenerationPrompt + "\n\n" + text
							}
						]
					},
					{
						headers: {
							"Content-Type": "application/json",
							"x-api-key": this.plugin.settings.anthropicApiKey,
							"anthropic-version": "2023-06-01",
							"anthropic-dangerous-direct-browser-access": "true"
						}
					}
				);
				return titleResponse.data.content[0].text
					.replace(/[/\\?%*:|"<>]/g, "-")
					.replace(/\n/g, " ")
					.trim();
			} else {
				titleResponse = await axios.post(
					"https://api.openai.com/v1/chat/completions",
					{
						model: this.plugin.settings.postProcessingModel || "gpt-4",
						messages: [
							{
								role: "system",
								content: this.plugin.settings.titleGenerationPrompt,
							},
							{
								role: "user",
								content: text,
							},
						],
						temperature: 0.7,
					},
					{
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${this.plugin.settings.openAiApiKey}`,
						},
					}
				);
				return titleResponse.data.choices[0].message.content.trim()
					.replace(/[/\\?%*:|"<>]/g, "-")
					.replace(/\n/g, " ")
					.trim();
			}
		} catch (titleErr: any) {
			console.error("Error generating title:", titleErr);
			new Notice("Error generating title: " + titleErr.message);
			return null;
		}
	}

	async sendAudioData(blob: Blob, fileName: string): Promise<{ transcription: string, originalText: string }> {
		// If silence removal is enabled, update the filename extension
		if (this.plugin.settings.useSilenceRemoval) {
			fileName = fileName.replace(/\.[^/.]+$/, '.wav');
			console.log("Using WAV filename:", fileName);
		}

		if (this.plugin.settings.debugMode) {
			console.log("Processing audio:", fileName);
			console.log("Audio format:", blob.type);
			console.log("Audio size:", blob.size);
		}

		try {
			// Create FormData object
			const formData = new FormData();
			formData.append("file", blob, fileName);
			formData.append("model", this.plugin.settings.model);
			formData.append("language", this.plugin.settings.language);
			if (this.plugin.settings.prompt) {
				formData.append("prompt", this.plugin.settings.prompt);
			}

			// Call Whisper API for transcription
			const whisperResponse = await axios.post(
				this.plugin.settings.apiUrl,
				formData,
				{
					headers: {
						"Content-Type": "multipart/form-data",
						Authorization: `Bearer ${this.plugin.settings.whisperApiKey}`,
					},
				}
			).catch(error => {
				if (error.response) {
					console.error("API Error Response:", {
						status: error.response.status,
						statusText: error.response.statusText,
						data: error.response.data
					});
					throw new Error(`API Error (${error.response.status}): ${JSON.stringify(error.response.data)}`);
				} else if (error.request) {
					console.error("No response received:", error.request);
					throw new Error("No response received from API");
				} else {
					console.error("Error setting up request:", error.message);
					throw error;
				}
			});

			let finalText = whisperResponse.data.text;
			const originalText = finalText;

			// Post-process if enabled
			if (this.plugin.settings.usePostProcessing && this.plugin.settings.postProcessingModel) {
				if (this.plugin.settings.debugMode) {
					new Notice("Post-processing transcription...");
				}

				try {
					let postProcessResponse;
					const isAnthropicModel = this.plugin.settings.postProcessingModel.startsWith('claude');

					if (isAnthropicModel) {
						if (!this.plugin.settings.anthropicApiKey) {
							throw new Error("Anthropic API key is required for Claude models");
						}

						postProcessResponse = await axios.post(
							"https://api.anthropic.com/v1/messages",
							{
								model: this.plugin.settings.postProcessingModel,
								max_tokens: 8190,
								messages: [
									{
										role: "user",
										content: this.plugin.settings.postProcessingPrompt + "\n\n" + finalText
									}
								]
							},
							{
								headers: {
									"Content-Type": "application/json",
									"x-api-key": this.plugin.settings.anthropicApiKey,
									"anthropic-version": "2023-06-01",
									"anthropic-dangerous-direct-browser-access": "true"
								}
							}
						);
						finalText = postProcessResponse.data.content[0].text;
					} else {
						postProcessResponse = await axios.post(
							"https://api.openai.com/v1/chat/completions",
							{
								model: this.plugin.settings.postProcessingModel,
								messages: [
									{
										role: "system",
										content: this.plugin.settings.postProcessingPrompt,
									},
									{
										role: "user",
										content: finalText,
									},
								],
								temperature: 0.7,
							},
							{
								headers: {
									"Content-Type": "application/json",
									Authorization: `Bearer ${this.plugin.settings.openAiApiKey}`,
								},
							}
						);
						finalText = postProcessResponse.data.choices[0].message.content.trim();
					}

					if (this.plugin.settings.debugMode) {
						new Notice("Post-processing complete.");
					}
				} catch (postErr: any) {
					console.error("Error during post-processing:", postErr);
					new Notice("Error during post-processing: " + postErr.message);
				}
			}

			return { transcription: finalText, originalText };
		} catch (err: any) {
			console.error("Error processing audio:", err);
			new Notice("Error processing audio: " + err.message);
			throw err;
		}
	}

	/**
	 * Convert a Blob to base64 string
	 */
	private blobToBase64(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onloadend = () => {
				if (typeof reader.result === 'string') {
					// Remove the data URL prefix if it exists
					const base64 = reader.result.includes('base64,') 
						? reader.result.split('base64,')[1]
						: reader.result;
					resolve(base64);
				} else {
					reject(new Error('Failed to convert blob to base64'));
				}
			};
			reader.onerror = reject;
			reader.readAsDataURL(blob);
		});
	}

	/**
	 * Convert AudioBuffer to WAV format
	 */
	private audioBufferToWav(buffer: AudioBuffer): Promise<Blob> {
		const numOfChan = buffer.numberOfChannels;
		const length = buffer.length * numOfChan * 2; // Length in bytes
		const buffer1 = new ArrayBuffer(44 + length);
		const view = new DataView(buffer1);

		if (this.plugin.settings.debugMode) {
			console.log("Creating WAV with:", {
				numberOfChannels: numOfChan,
				sampleRate: buffer.sampleRate,
				length: length,
				totalSize: 44 + length
			});
		}

		// Write WAV header
		// "RIFF" chunk descriptor
		view.setUint8(0, 0x52); // 'R'
		view.setUint8(1, 0x49); // 'I'
		view.setUint8(2, 0x46); // 'F'
		view.setUint8(3, 0x46); // 'F'
		view.setUint32(4, 36 + length, true); // Chunk size
		view.setUint8(8, 0x57);  // 'W'
		view.setUint8(9, 0x41);  // 'A'
		view.setUint8(10, 0x56); // 'V'
		view.setUint8(11, 0x45); // 'E'

		// "fmt " sub-chunk
		view.setUint8(12, 0x66); // 'f'
		view.setUint8(13, 0x6D); // 'm'
		view.setUint8(14, 0x74); // 't'
		view.setUint8(15, 0x20); // ' '
		view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
		view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
		view.setUint16(22, numOfChan, true); // NumChannels
		view.setUint32(24, buffer.sampleRate, true); // SampleRate
		view.setUint32(28, buffer.sampleRate * numOfChan * 2, true); // ByteRate
		view.setUint16(32, numOfChan * 2, true); // BlockAlign
		view.setUint16(34, 16, true); // BitsPerSample

		// "data" sub-chunk
		view.setUint8(36, 0x64); // 'd'
		view.setUint8(37, 0x61); // 'a'
		view.setUint8(38, 0x74); // 't'
		view.setUint8(39, 0x61); // 'a'
		view.setUint32(40, length, true); // Subchunk2Size

		// Write interleaved audio data
		const channels = Array.from({length: buffer.numberOfChannels}, (_, i) => buffer.getChannelData(i));
		let offset = 44;
		for (let i = 0; i < buffer.length; i++) {
			for (let channel = 0; channel < numOfChan; channel++) {
				let sample = Math.max(-1, Math.min(1, channels[channel][i]));
				sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
				view.setInt16(offset, sample, true);
				offset += 2;
			}
		}

		if (this.plugin.settings.debugMode) {
			const header = new Uint8Array(buffer1.slice(0, 44));
			console.log("WAV header check:", {
				ascii: Array.from(header).map(b => String.fromCharCode(b)).join(''),
				hex: Array.from(header).map(b => b.toString(16).padStart(2, '0')).join(' ')
			});
		}

		// Return the WAV blob
		return Promise.resolve(new Blob([buffer1], { type: 'audio/wav' }));
	}

	/**
	 * Helper to get first n bytes of a blob for debugging
	 */
	private async getFirstBytes(blob: Blob, n: number): Promise<string> {
		const buffer = await blob.slice(0, n).arrayBuffer();
		return Array.from(new Uint8Array(buffer))
			.map(b => b.toString(16).padStart(2, '0'))
			.join(' ');
	}

	/**
	 * Process audio buffer to remove silence
	 */
	private async removeSilence(buffer: AudioBuffer): Promise<Float32Array> {
		// For now, just return the first channel's data
		// The actual silence removal is handled in AudioRecorder
		return buffer.getChannelData(0);
	}

	/**
	 * Delete all transcripts from AssemblyAI
	 * Note: We use Node.js https module directly instead of the AssemblyAI SDK because
	 * the SDK's delete method uses browser's fetch API which triggers CORS preflight checks.
	 * Since we're in Electron (Obsidian), using Node.js https module bypasses these CORS restrictions.
	 */
	public async deleteAllTranscripts(): Promise<void> {
		try {
			// Get user input for deletion count
			const { count, deleteAll } = await this.promptForDeletionCount();
			
			if (!count && !deleteAll) {
				return; // User cancelled
			}

			// Initialize AssemblyAI client
			this.initializeAssemblyAI();
			if (!this.assemblyClient) {
				throw new Error("Failed to initialize AssemblyAI client");
			}

			let transcriptsToDelete: TranscriptListItem[] = [];
			let previousPageUrl: string | null = null;
			let totalFound = 0;

			do {
				if (this.plugin.settings.debugMode) {
					console.log("Fetching transcripts page...", { previousPageUrl });
				}

				// Get list of transcripts for current page
				const listParams: string | { limit: number } = previousPageUrl || { limit: 100 }; // Get 100 transcripts per page instead of default 10
				const page: { transcripts: TranscriptListItem[]; page_details?: { prev_url: string | null } } = await this.assemblyClient.transcripts.list(listParams);
				
				if (this.plugin.settings.debugMode) {
					console.log("Raw transcript list:", page);
				}

				// Extract valid transcripts from current page
				let pageTranscripts: TranscriptListItem[] = [];
				if (Array.isArray(page)) {
					pageTranscripts = page.filter((t: TranscriptListItem) => t && typeof t === 'object' && 'id' in t && typeof t.id === 'string' && t.id.length > 0);
				} else if (page && typeof page === 'object' && 'transcripts' in page) {
					pageTranscripts = page.transcripts.filter((t: TranscriptListItem) => t && typeof t === 'object' && 'id' in t && typeof t.id === 'string' && t.id.length > 0);
				}

				transcriptsToDelete = transcriptsToDelete.concat(pageTranscripts);
				totalFound += pageTranscripts.length;

				if (this.plugin.settings.debugMode) {
					console.log(`Found ${pageTranscripts.length} valid transcripts on current page`);
				}

				// Update previousPageUrl for next iteration
				previousPageUrl = page.page_details?.prev_url || null;

				// If we're not deleting all and we have enough transcripts, break
				if (!deleteAll && totalFound >= (count || 0)) {
					break;
				}
			} while (previousPageUrl !== null);

			// Slice to the requested count if not deleting all
			if (!deleteAll && count) {
				transcriptsToDelete = transcriptsToDelete.slice(0, count);
			}

			if (transcriptsToDelete.length === 0) {
				new Notice("No valid transcripts found to delete");
				return;
			}

			// Delete each transcript
			for (const transcript of transcriptsToDelete) {
				try {
					if (this.plugin.settings.debugMode) {
						console.log(`Testing GET request for transcript: ${transcript.id}`);
					}
					
					// First try to GET the transcript
					const transcriptDetails = await this.assemblyClient.transcripts.get(transcript.id);
					if (this.plugin.settings.debugMode) {
						console.log(`Successfully retrieved transcript details:`, transcriptDetails);
					}

					if (this.plugin.settings.debugMode) {
						console.log(`Attempting to delete transcript: ${transcript.id}`);
					}

					await new Promise<void>((resolve, reject) => {
						const options = {
							hostname: 'api.assemblyai.com',
							port: 443,
							path: `/v2/transcript/${transcript.id}`,
							method: 'DELETE',
							headers: {
								'Authorization': this.plugin.settings.assemblyAiApiKey
							}
						};

						const req = https.request(options, (res) => {
							if (res.statusCode === 200 || res.statusCode === 204) {
								resolve();
							} else {
								reject(new Error(`Failed to delete transcript: ${res.statusCode}`));
							}
						});

						req.on('error', (error: Error) => {
							reject(error);
						});

						req.end();
					});

					if (this.plugin.settings.debugMode) {
						console.log(`Successfully deleted transcript: ${transcript.id}`);
					}
				} catch (deleteError) {
					console.error(`Error with transcript ${transcript.id}:`, deleteError);
				}
			}

			new Notice(`Successfully deleted ${transcriptsToDelete.length} transcripts`);
		} catch (error) {
			console.error("Error deleting transcripts:", error);
			new Notice(`Error deleting transcripts: ${error.message}`);
		}
	}
}