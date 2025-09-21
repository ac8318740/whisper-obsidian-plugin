# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Development build**: `npm run dev` - Builds and watches for changes using esbuild
- **Production build**: `npm run build` - TypeScript type checking followed by production esbuild
- **Release**: `npm run release` - Creates a new release using release-it

## Architecture Overview

This is an Obsidian plugin for speech-to-text transcription using multiple services (OpenAI Whisper and AssemblyAI). The plugin is built in TypeScript and uses a modular architecture:

### Core Components

- **main.ts**: Entry point that initializes all components and registers commands/ribbons
- **AudioHandler.ts**: Central processing hub that handles transcription flow for both Whisper and AssemblyAI services
- **AudioRecorder.ts**: Native browser MediaRecorder API wrapper for audio capture
- **SettingsManager.ts**: Manages plugin settings persistence and defaults
- **WhisperSettingsTab.ts**: Settings UI configuration panel

### Key Features

- **Dual transcription services**: Supports both OpenAI Whisper API and AssemblyAI
- **Speaker diarization**: AssemblyAI integration with speaker identification and review workflow
- **Post-processing**: AI-powered text enhancement using OpenAI GPT or Anthropic Claude models
- **Auto-title generation**: Automatic note title creation from transcription content
- **Temporary recording recovery**: Crash recovery system for unsaved recordings via TempRecordingManager
- **Audio file management**: Save recordings alongside transcriptions with configurable paths

### Critical Architecture Points

1. **Service Selection**: The `transcriptionService` setting determines whether to use Whisper or AssemblyAI pipeline in `AudioHandler.processAudioChunks()`

2. **Speaker Workflow**: AssemblyAI uses a interactive review process with `SpeakerReviewModal` for speaker identification before final processing

3. **Post-processing Pipeline**: Both services support optional AI enhancement via multiple model providers (OpenAI/Anthropic) with custom prompts

4. **File Organization**: Audio files and transcriptions can be saved to configurable vault folders with timestamp-based naming

5. **Error Recovery**: `TempRecordingManager` provides crash recovery by persisting recordings and prompting for recovery on plugin load

6. **Status Management**: `StatusBar` provides real-time feedback on recording/processing states

## Key Files to Understand

- `src/AudioHandler.ts`: Contains the main transcription logic and service routing
- `src/SettingsManager.ts`: Defines all plugin configuration options and defaults
- `src/SpeakerReviewModal.ts`: Interactive speaker identification UI for AssemblyAI
- `src/TempRecordingManager.ts`: Crash recovery system with incremental chunk writing
- `src/AudioRecorder.ts`: Audio recording with optimized chunk processing
- `src/AudioContextManager.ts`: Centralized AudioContext resource management
- `src/Timer.ts`: Recording timer with efficient update frequency

## Performance Optimizations

The plugin has been optimized to resolve 100% CPU usage issues in Obsidian 1.9.X:

- **Incremental chunk processing**: Audio chunks are written individually during recording instead of processing the entire recording every second
- **AudioContext management**: Centralized management prevents resource leaks
- **Timer optimization**: Updates reduced from 100x/second to 1x/second
- **Event listener cleanup**: Proper cleanup prevents memory leaks
- **Recovery-time conversion**: Audio format conversion only happens during crash recovery, not during active recording

## Build Output

The build process generates `main.js`, which along with `manifest.json` and `styles.css`, comprises the complete plugin package for Obsidian installation.