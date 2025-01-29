import { Plugin } from "obsidian";


export interface WhisperSettings {
	whisperApiKey: string;
	openAiApiKey: string;
	anthropicApiKey: string;
	apiUrl: string;
	model: string;
	prompt: string;
	language: string;
	saveAudioFile: boolean;
	saveAudioFilePath: string;
	debugMode: boolean;
	createNewFileAfterRecording: boolean;
	createNewFileAfterRecordingPath: string;

	// New fields:
	usePostProcessing: boolean;             // (1) Use postprocessing
	postProcessingPrompt: string;           // (2) Post-processing prompt
	postProcessingModel: string;            // (3) Model dropdown
	autoGenerateTitle: boolean;             // (4) Auto generate title
	titleGenerationPrompt: string;          // (5) Title-generation prompt
	keepOriginalTranscription: boolean;

	// Silence removal settings
	useSilenceRemoval: boolean;
	silenceThreshold: number;  // in dB
	silenceDuration: number;   // in seconds
	silenceRemoveAll: boolean; // whether to remove all silence periods

	transcriptionService: "whisper" | "assemblyai";
	assemblyAiApiKey: string;
	useSpeakerDiarization: boolean;
	speakerCount?: number;
	wordBoost: string[]; // Array of words to boost during transcription
	assemblyAiModel: "best" | "nano";
	boostParam: "low" | "default" | "high"; // Parameter to control word boost weight
	useCustomModel: boolean;  // Add new setting for custom model input
}

export const DEFAULT_SETTINGS: WhisperSettings = {
	whisperApiKey: "",
	openAiApiKey: "",
	anthropicApiKey: "",
	apiUrl: "https://api.openai.com/v1/audio/transcriptions",
	model: "whisper-1",
	prompt: "",
	language: "en",
	saveAudioFile: true,
	saveAudioFilePath: "",
	debugMode: false,
	createNewFileAfterRecording: true,
	createNewFileAfterRecordingPath: "",

	// Set defaults for new settings
	usePostProcessing: false,
	postProcessingPrompt: "",
	postProcessingModel: "gpt-4o",
	autoGenerateTitle: true,
	titleGenerationPrompt: "You are an intelligent bureaucratic assistant. You are tasked with generating a short (1-5 words), precise title for the TEXT below. Reply only with the title, nothing else. Generate the title in the main language of the TEXT. TEXT:",
	keepOriginalTranscription: false,

	// Default silence removal settings
	useSilenceRemoval: false,
	silenceThreshold: -30,
	silenceDuration: 2,
	silenceRemoveAll: true,

	transcriptionService: "whisper",
	assemblyAiApiKey: "",
	useSpeakerDiarization: false,
	speakerCount: undefined,
	wordBoost: [], // Default to empty array
	assemblyAiModel: "best",
	boostParam: "default", // Default boost parameter
	useCustomModel: false,  // Default value for useCustomModel
};

export class SettingsManager {
	private plugin: Plugin;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
	}

	async loadSettings(): Promise<WhisperSettings> {
		return Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.plugin.loadData()
		);
	}

	async saveSettings(settings: WhisperSettings): Promise<void> {
		await this.plugin.saveData(settings);
	}
}
