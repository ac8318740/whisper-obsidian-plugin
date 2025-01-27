import { App, Modal, Setting, Notice } from 'obsidian';

export interface SpeakerModalResult {
    confirmed: boolean;
    speakers: string[];
}

export class SpeakerModal extends Modal {
    private speakers: string[] = [''];
    private useAttendees = false;
    private onSubmit: (result: SpeakerModalResult) => void;

    constructor(app: App, onSubmit: (result: SpeakerModalResult) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    private async getAttendeesFromFrontmatter(): Promise<string[]> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return [];

        try {
            const fileCache = this.app.metadataCache.getFileCache(activeFile);
            const frontmatter = fileCache?.frontmatter;
            if (!frontmatter || !frontmatter.Attendees) return [];

            // Handle both array and string formats
            const attendees = Array.isArray(frontmatter.Attendees) 
                ? frontmatter.Attendees 
                : frontmatter.Attendees.split(',').map((s: string) => s.trim());

            return attendees.filter((a: string) => a && a.trim() !== '');
        } catch (error) {
            console.error("Error reading frontmatter:", error);
            return [];
        }
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();

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

        contentEl.createEl('h2', { text: 'Enter Speaker Names' });
        contentEl.createEl('p', { text: 'Enter the names of the speakers in the conversation.' });

        // Add toggle for using Attendees frontmatter
        new Setting(contentEl)
            .setName("Use Attendees from Frontmatter")
            .setDesc("Use the Attendees list from the current note's frontmatter")
            .addToggle(toggle => toggle
                .setValue(this.useAttendees)
                .onChange(async (value) => {
                    this.useAttendees = value;
                    if (value) {
                        const attendees = await this.getAttendeesFromFrontmatter();
                        if (attendees.length > 0) {
                            this.speakers = attendees;
                            this.updateSpeakerInputs(speakerContainer);
                        } else {
                            new Notice("No attendees found in frontmatter");
                            this.useAttendees = false;
                            toggle.setValue(false);
                        }
                    }
                }));

        const speakerContainer = contentEl.createDiv('speaker-container');
        this.updateSpeakerInputs(speakerContainer);

        // Add speaker button (only show if not using attendees)
        const addSpeakerSetting = new Setting(contentEl)
            .setName("Add Speaker")
            .addButton(button => button
                .setButtonText('Add Speaker')
                .onClick(() => {
                    this.speakers.push('');
                    this.updateSpeakerInputs(speakerContainer);
                }));

        // Update visibility based on useAttendees
        addSpeakerSetting.settingEl.style.display = this.useAttendees ? 'none' : 'block';

        // Submit button
        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('Cancel')
                .onClick(() => {
                    this.onSubmit({ confirmed: false, speakers: [] });
                    this.close();
                }))
            .addButton(button => button
                .setButtonText('Submit')
                .setCta()
                .onClick(() => {
                    const validSpeakers = this.speakers.filter(s => s.trim() !== '');
                    if (validSpeakers.length === 0) {
                        // If no speakers, just close without speaker labels
                        this.onSubmit({ confirmed: false, speakers: [] });
                    } else {
                        this.onSubmit({ confirmed: true, speakers: validSpeakers });
                    }
                    this.close();
                }));
    }

    private updateSpeakerInputs(container: HTMLElement) {
        container.empty();
        this.speakers.forEach((speaker, index) => {
            const speakerDiv = container.createDiv('speaker-input');
            new Setting(speakerDiv)
                .setName(`Speaker ${index + 1}`)
                .addText(text => text
                    .setValue(speaker)
                    .setDisabled(this.useAttendees)
                    .onChange(value => {
                        if (!this.useAttendees) {
                            this.speakers[index] = value;
                        }
                    })
                    // Add keyboard handler for Enter key
                    .inputEl.addEventListener('keydown', (evt: KeyboardEvent) => {
                        if (evt.key === 'Enter') {
                            evt.preventDefault();
                            // Find and click the submit button
                            const submitButton = this.contentEl.querySelector('.mod-cta');
                            if (submitButton instanceof HTMLButtonElement) {
                                submitButton.click();
                            }
                        }
                    }));
            new Setting(speakerDiv)
                .addExtraButton(button => button
                    .setIcon('trash')
                    .setTooltip('Remove speaker')
                    .setDisabled(this.useAttendees) // Disable removal if using attendees
                    .onClick(() => {
                        if (!this.useAttendees) {
                            this.speakers.splice(index, 1);
                            if (this.speakers.length === 0) {
                                this.speakers.push('');
                            }
                            this.updateSpeakerInputs(container);
                        }
                    }));
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
} 
