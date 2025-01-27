import { App, Modal, Setting, Notice, TFile } from 'obsidian';

interface SpeakerSample {
    speaker: string;
    text: string;
}

export interface SpeakerIdentification {
    speaker: string;
    name?: string;
    selectedAttendee?: string;
    alias?: string;
}

export interface SpeakerReviewResult {
    accepted: boolean;
    speakerCount?: number;  // Only present if rejected
    speakerIdentifications?: SpeakerIdentification[];  // Present when accepted
}

export class SpeakerReviewModal extends Modal {
    private speakerSamples: SpeakerSample[];
    private onSubmit: (result: SpeakerReviewResult) => void;
    private previousAttempts: number[] = [];
    private currentFile: TFile | null;
    private attendees: string[] = [];

    constructor(
        app: App, 
        speakerSamples: SpeakerSample[], 
        previousAttempts: number[],
        currentFile: TFile | null,
        onSubmit: (result: SpeakerReviewResult) => void
    ) {
        super(app);
        this.speakerSamples = speakerSamples;
        this.previousAttempts = previousAttempts;
        this.currentFile = currentFile;
        this.onSubmit = onSubmit;
        this.loadAttendees();
    }

    private async loadAttendees() {
        if (!this.currentFile) {
            console.debug("No current file available");
            return;
        }

        try {
            // Get frontmatter using Obsidian API
            const cache = this.app.metadataCache.getFileCache(this.currentFile);
            const frontmatter = cache?.frontmatter;
            
            console.debug("Frontmatter from API:", frontmatter);
            
            if (frontmatter) {
                // Try both cases of "attendees"
                const attendeesList = frontmatter.Attendees || frontmatter.attendees;
                console.debug("Found attendees list:", attendeesList);

                if (Array.isArray(attendeesList)) {
                    // Clean up Obsidian links by removing [[]] and store original values
                    this.attendees = attendeesList.map(attendee => {
                        if (typeof attendee !== 'string') {
                            console.debug("Non-string attendee:", attendee);
                            return '';
                        }
                        // Remove quotes if present
                        attendee = attendee.replace(/^["']|["']$/g, '');
                        // Remove double square brackets if present
                        return attendee.replace(/^\[\[(.*?)\]\]$/, '$1');
                    }).filter(Boolean);

                    console.debug("Processed attendees:", this.attendees);
                } else {
                    console.debug("Attendees list is not an array:", attendeesList);
                }
            } else {
                console.debug("No frontmatter found in file");
            }
        } catch (error) {
            console.error("Error loading attendees:", error);
            this.attendees = [];
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        this.showSpeakerReview();

        // Add keyboard listener
        this.scope.register([], 'Enter', (evt) => {
            const activeElement = document.activeElement;
            // Don't trigger if we're in a text input
            if (activeElement instanceof HTMLInputElement) {
                return false;
            }
            // Find and click the primary (CTA) button
            const ctaButton = contentEl.querySelector('.mod-cta');
            if (ctaButton instanceof HTMLButtonElement) {
                ctaButton.click();
            }
            return false;
        });
    }

    private showSpeakerReview() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Review Speaker Detection' });
        contentEl.createEl('p', { text: 'AssemblyAI detected the following speakers. Please review their first utterances:' });

        // Show speaker samples
        const samplesContainer = contentEl.createDiv('speaker-samples');
        this.speakerSamples.forEach(sample => {
            const sampleDiv = samplesContainer.createDiv('speaker-sample');
            const speakerLabel = sampleDiv.createSpan('speaker-label');
            speakerLabel.createEl('strong', { text: sample.speaker });
            const textBlock = sampleDiv.createSpan('speaker-text');
            textBlock.setText(sample.text);

            // Add styles
            sampleDiv.style.display = 'flex';
            sampleDiv.style.gap = '1em';
            sampleDiv.style.marginBottom = '1em';
            speakerLabel.style.minWidth = '120px';
            speakerLabel.style.flexShrink = '0';
            textBlock.style.flex = '1';
            textBlock.style.paddingLeft = '1em';
            textBlock.style.borderLeft = '1px solid var(--background-modifier-border)';
            textBlock.style.whiteSpace = 'pre-wrap';
            textBlock.style.wordBreak = 'break-word';
            textBlock.style.display = 'block';
        });

        // Show previous attempts if any
        if (this.previousAttempts.length > 0) {
            const attemptsDiv = contentEl.createDiv('previous-attempts');
            attemptsDiv.createEl('p', { 
                text: `Previous attempts with speaker counts: ${this.previousAttempts.join(', ')}`
            });
        }

        // Buttons
        const buttonContainer = contentEl.createDiv('button-container');
        
        // Accept button
        new Setting(buttonContainer)
            .addButton(button => button
                .setButtonText('Accept Speaker Detection')
                .setCta()
                .onClick(() => {
                    this.showSpeakerIdentification();
                }));

        // Reject button
        new Setting(buttonContainer)
            .addButton(button => button
                .setButtonText('Incorrect Number of Speakers')
                .onClick(() => {
                    this.showSpeakerCountPrompt();
                }));

        // Note about escape/clicking outside
        contentEl.createEl('p', { 
            text: 'Note: Pressing escape or clicking outside will accept the current speaker detection.',
            cls: 'speaker-review-note'
        });
    }

    private showSpeakerIdentification() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Identify Speakers' });
        contentEl.createEl('p', { text: 'Please identify each speaker using the options below.' });

        const identificationContainer = contentEl.createDiv('speaker-identification');
        const speakerIdentifications: SpeakerIdentification[] = [];

        this.speakerSamples.forEach(sample => {
            const speakerSection = identificationContainer.createDiv('speaker-section');
            
            // Sample text display
            const sampleDiv = speakerSection.createDiv('speaker-sample');
            const speakerLabel = sampleDiv.createSpan('speaker-label');
            speakerLabel.createEl('strong', { text: sample.speaker });
            const textBlock = sampleDiv.createSpan('speaker-text');
            textBlock.setText(sample.text);

            // Style the sample text similar to review screen
            sampleDiv.style.display = 'flex';
            sampleDiv.style.gap = '1em';
            sampleDiv.style.marginBottom = '0.5em';
            speakerLabel.style.minWidth = '120px';
            speakerLabel.style.flexShrink = '0';
            textBlock.style.flex = '1';
            textBlock.style.paddingLeft = '1em';
            textBlock.style.borderLeft = '1px solid var(--background-modifier-border)';
            textBlock.style.whiteSpace = 'pre-wrap';
            textBlock.style.wordBreak = 'break-word';
            textBlock.style.display = 'block';

            // Input controls container
            const controlsDiv = speakerSection.createDiv('speaker-controls');
            controlsDiv.style.display = 'flex';
            controlsDiv.style.gap = '1em';
            controlsDiv.style.marginLeft = 'calc(120px + 2em)';  // Align with text
            controlsDiv.style.marginBottom = '1.5em';

            const identification: SpeakerIdentification = {
                speaker: sample.speaker
            };
            speakerIdentifications.push(identification);

            // Create container for dropdown (if needed) and text input
            const inputContainer = controlsDiv.createDiv('input-container');
            inputContainer.style.display = 'flex';
            inputContainer.style.gap = '1em';
            inputContainer.style.flex = '1';

            // Name/Alias input
            const textInput = inputContainer.createEl('input', {
                type: 'text',
                placeholder: 'Enter speaker name'
            });
            textInput.style.flex = '1';

            // Only create dropdown if there are attendees
            if (this.attendees.length > 0) {
                // Attendees dropdown - add it before the text input
                const dropdown = inputContainer.createEl('select');
                dropdown.style.minWidth = '150px';
                inputContainer.insertBefore(dropdown, textInput);
                
                // Add empty option
                dropdown.createEl('option', {
                    text: 'Select attendee',
                    value: ''
                });

                // Add attendee options
                this.attendees.forEach(attendee => {
                    dropdown.createEl('option', {
                        text: attendee,
                        value: attendee
                    });
                });

                // Handle dropdown changes
                dropdown.addEventListener('change', () => {
                    identification.selectedAttendee = dropdown.value;
                    // Update text input placeholder based on dropdown selection
                    textInput.placeholder = dropdown.value ? 'Enter alias (optional)' : 'Enter speaker name';
                    // If dropdown is selected, store any text input as alias, otherwise as name
                    if (dropdown.value) {
                        identification.name = undefined;
                        identification.alias = textInput.value || undefined;
                    } else {
                        identification.name = textInput.value || undefined;
                        identification.alias = undefined;
                    }
                });

                // Handle text input changes
                textInput.addEventListener('input', () => {
                    if (dropdown.value) {
                        identification.alias = textInput.value || undefined;
                    } else {
                        identification.name = textInput.value || undefined;
                    }
                });
            } else {
                // If no attendees, just handle text input as name
                textInput.addEventListener('input', () => {
                    identification.name = textInput.value || undefined;
                });
            }
        });

        // Submit button
        const buttonContainer = contentEl.createDiv('button-container');
        new Setting(buttonContainer)
            .addButton(button => button
                .setButtonText('Submit Identifications')
                .setCta()
                .onClick(async () => {
                    // Check if any speakers are unidentified
                    const unidentified = speakerIdentifications.filter(
                        id => !id.name && !id.selectedAttendee
                    );

                    if (unidentified.length > 0) {
                        // Show confirmation dialog
                        const confirm = await new Promise<boolean>(resolve => {
                            const modal = new Modal(this.app);
                            modal.titleEl.setText('Confirm Submission');
                            modal.contentEl.createEl('p', {
                                text: `${unidentified.length} speaker(s) are not identified. Do you want to continue?`
                            });

                            // Add global Enter key handler
                            modal.scope.register([], 'Enter', () => {
                                resolve(true);
                                modal.close();
                                return false;
                            });

                            new Setting(modal.contentEl)
                                .addButton(btn => btn
                                    .setButtonText('Cancel')
                                    .onClick(() => {
                                        resolve(false);
                                        modal.close();
                                    }))
                                .addButton(btn => btn
                                    .setButtonText('Continue')
                                    .setCta()
                                    .onClick(() => {
                                        resolve(true);
                                        modal.close();
                                    }));

                            modal.open();
                        });

                        if (!confirm) return;
                    }

                    this.onSubmit({
                        accepted: true,
                        speakerIdentifications
                    });
                    this.close();
                }));

        // Add keyboard listener for text inputs
        const textInputs = contentEl.querySelectorAll('input[type="text"]');
        textInputs.forEach((input, index) => {
            input.addEventListener('keydown', (evt: KeyboardEvent) => {
                if (evt.key === 'Enter') {
                    evt.preventDefault();
                    // If this is the last input, submit the form
                    if (index === textInputs.length - 1) {
                        const submitButton = contentEl.querySelector('.mod-cta');
                        if (submitButton instanceof HTMLButtonElement) {
                            submitButton.click();
                        }
                    } else {
                        // Focus the next input
                        const nextInput = textInputs[index + 1] as HTMLInputElement;
                        if (nextInput) {
                            nextInput.focus();
                        }
                    }
                }
            });
        });
    }

    private showSpeakerCountPrompt() {
        const promptDiv = document.createElement('div');
        promptDiv.addClass('speaker-count-prompt');
        
        const modal = new Modal(this.app);
        modal.titleEl.setText('Enter Speaker Count');
        
        const { contentEl } = modal;
        let speakerCount: number | undefined;

        // Add global Enter key handler
        modal.scope.register([], 'Enter', (evt) => {
            const activeElement = document.activeElement;
            // Don't trigger if we're in a text input
            if (activeElement instanceof HTMLInputElement) {
                return false;
            }
            // Find and click the primary (CTA) button
            const ctaButton = contentEl.querySelector('.mod-cta');
            if (ctaButton instanceof HTMLButtonElement) {
                ctaButton.click();
            }
            return false;
        });

        new Setting(contentEl)
            .setName('Number of Speakers')
            .setDesc('Enter the correct number of speakers in the audio')
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
                }))
            .addButton(button => button
                .setButtonText('Submit')
                .setCta()
                .onClick(() => {
                    if (!speakerCount || speakerCount < 1) {
                        new Notice('Please enter a valid number of speakers');
                        return;
                    }
                    this.onSubmit({ 
                        accepted: false, 
                        speakerCount 
                    });
                    modal.close();
                    this.close();
                }));

        modal.open();

        // Add keyboard listener for the number input
        const numberInput = contentEl.querySelector('input[type="text"]');
        if (numberInput) {
            numberInput.addEventListener('keydown', (evt: KeyboardEvent) => {
                if (evt.key === 'Enter') {
                    evt.preventDefault();
                    const submitButton = contentEl.querySelector('.mod-cta');
                    if (submitButton instanceof HTMLButtonElement) {
                        submitButton.click();
                    }
                }
            });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        // If closed without explicit accept/reject, treat as accept
        this.onSubmit({ accepted: true });
    }
} 