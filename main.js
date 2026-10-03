/*
 * Themed Journal Capture
 * ------------------------------------------------------------------
 * A quick-capture modal for Obsidian.
 *
 * Flow:
 *  1. Trigger the "Open capture window" command (bind a hotkey to it
 *     in Settings > Hotkeys).
 *  2. Type your entry into the textarea.
 *  3. - Press Tab (or tap "Choose note")  -> pick any markdown file,
 *       entry is inserted as a bullet right below the configured
 *       heading (heading is created at the top of the file if it's
 *       missing).
 *     - Press Enter without Shift (or tap "Send to inbox") -> entry
 *       goes straight to the configured inbox note, same rule.
 *     - Shift+Enter -> inserts a normal newline (multi-line entries
 *       are supported and indented so they stay one bullet item).
 *     - Escape / the modal's close (x) button -> abandon the entry,
 *       nothing is written anywhere.
 *
 * No build step required: this file is plain CommonJS JS, loaded
 * directly by Obsidian.
 */

const { Plugin, Modal, FuzzySuggestModal, PluginSettingTab, Setting, Notice, TFile, normalizePath, getAllTags, Platform } = require("obsidian");

const DEFAULT_SETTINGS = {
	heading: "## Journal",
	dateFormat: "date", // "none" | "date" | "datetime"
	useBullet: true,
	enableInbox: true,
	inboxPath: "Inbox.md",
	// Only used when enableInbox is false - what plain Enter does instead.
	disabledInboxEnterAction: "copy", // "copy" | "newline"
	confirmBeforeDiscard: true,
	// Optional modifier+Enter shortcuts inside the capture window.
	recentNoteHotkey: { enabled: false, modifier: "Meta" }, // modifier: "Meta" | "Ctrl" | "Alt"
	lastUsedNoteHotkey: { enabled: false, modifier: "Ctrl" },
	// Internal state (not a user-facing setting): notes the plugin has
	// actually written entries into, by any method, most recent first,
	// capped at USED_FILE_HISTORY_LIMIT.
	usedFileHistory: [],
	// Each category: { name, sourceType, files, folderPath, tag, propertyKey, propertyValue }
	// sourceType is one of "files" | "folder" | "tag" | "property" | "bookmarks".
	categories: [],
};

function pad(n) {
	return n < 10 ? "0" + n : "" + n;
}

// Fallback formatter in case window.moment isn't available for some reason.
function formatDateFallback(withTime) {
	const d = new Date();
	const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	if (!withTime) return date;
	return `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTimestamp(dateFormat) {
	if (dateFormat === "none") return "";
	const withTime = dateFormat === "datetime";
	if (typeof window !== "undefined" && window.moment) {
		return window.moment().format(withTime ? "YYYY-MM-DDTHH:mm" : "YYYY-MM-DD");
	}
	return formatDateFallback(withTime);
}

// How many entries the "recently used" history keeps.
const USED_FILE_HISTORY_LIMIT = 25;

function modifierDisplayName(mod) {
	if (mod === "Meta") return Platform.isMacOS ? "Cmd" : "Win";
	if (mod === "Alt") return Platform.isMacOS ? "Option" : "Alt";
	return "Ctrl";
}

// Matches an exact single modifier - e.g. "Ctrl" only fires when Ctrl is
// held and Meta/Alt are not, so the two configurable hotkeys (and plain
// Enter) never accidentally overlap.
function matchesModifier(evt, modifier) {
	const meta = !!evt.metaKey;
	const ctrl = !!evt.ctrlKey;
	const alt = !!evt.altKey;
	if (modifier === "Meta") return meta && !ctrl && !alt;
	if (modifier === "Ctrl") return ctrl && !meta && !alt;
	if (modifier === "Alt") return alt && !meta && !ctrl;
	return false;
}

class CaptureModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
		this.submitted = false;
		this.mode = "edit"; // "edit" | "categories" | "files" | "recent" | "history" | "confirm"
		this.activeCategoryIndex = -1;
		this.highlightIndex = 0;
		this._confirmedDiscard = false;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("tjc-capture-modal");
		this.modalEl.addClass("tjc-modal");
		this.containerEl.addClass("tjc-modal-container");

		this.setTitle ? this.setTitle("Themed journal capture") : contentEl.createEl("h3", { text: "Themed journal capture" });

		// --- Edit view: the textarea plus its hint/buttons -----------------
		this.editContainer = contentEl.createDiv({ cls: "tjc-edit-container" });

		this.textarea = this.editContainer.createEl("textarea", { cls: "tjc-textarea" });
		this.textarea.rows = 8;
		this.textarea.placeholder = "Write your entry…";

		const hint = this.editContainer.createEl("div", { cls: "tjc-hint" });
		hint.setText(this.buildHintText());

		const btnRow = this.editContainer.createDiv({ cls: "tjc-btn-row" });

		if (this.plugin.settings.enableInbox) {
			const inboxBtn = btnRow.createEl("button", { text: "Send to inbox", cls: "tjc-btn tjc-btn-primary" });
			inboxBtn.addEventListener("click", () => this.handlePlainEnter());
		} else if (this.plugin.settings.disabledInboxEnterAction === "copy") {
			const copyBtn = btnRow.createEl("button", { text: "Copy entry", cls: "tjc-btn tjc-btn-primary" });
			copyBtn.addEventListener("click", () => this.handlePlainEnter());
		}

		const chooseBtn = btnRow.createEl("button", { text: "Choose note…", cls: "tjc-btn" });
		chooseBtn.addEventListener("click", () => this.handleTab());

		if (this.plugin.settings.categories.length > 0) {
			const categoriesBtn = btnRow.createEl("button", { text: "Categories…", cls: "tjc-btn" });
			categoriesBtn.addEventListener("click", () => this.handleUpArrow());
		}

		if (this.plugin.settings.recentNoteHotkey.enabled) {
			const recentBtn = btnRow.createEl("button", { text: "Recent notes", cls: "tjc-btn" });
			recentBtn.setAttribute("title", `Shortcut: ${modifierDisplayName(this.plugin.settings.recentNoteHotkey.modifier)}+Enter`);
			recentBtn.addEventListener("click", () => this.enterRecentNotesMode());
		}

		if (this.plugin.settings.lastUsedNoteHotkey.enabled) {
			const lastUsedBtn = btnRow.createEl("button", { text: "Recently used", cls: "tjc-btn" });
			lastUsedBtn.setAttribute("title", `Shortcut: ${modifierDisplayName(this.plugin.settings.lastUsedNoteHotkey.modifier)}+Enter`);
			lastUsedBtn.addEventListener("click", () => this.enterHistoryMode());
		}

		// --- Browse view: category list, then file list within a category -
		this.browseContainer = contentEl.createDiv({ cls: "tjc-browse-container" });
		this.browseContainer.setAttribute("tabindex", "-1");
		this.browseContainer.style.display = "none";

		// A single keydown listener on contentEl catches events bubbling up
		// from whichever child currently has focus (textarea or the browse
		// list), so we don't need to juggle multiple listeners per mode.
		contentEl.addEventListener("keydown", (evt) => this.handleKeydown(evt));

		// Mobile keyboards shrink the visual viewport without shrinking the
		// layout viewport, which is what was leaving the bottom of the modal
		// (hint/buttons, sometimes the textarea itself) hidden behind the
		// keyboard. CSS handles most of it via dvh units, but on WebViews
		// that don't respect dvh reliably we re-clamp the modal height here
		// and make sure the caret/textarea stays scrolled into view.
		this._onViewportChange = () => {
			if (!window.visualViewport) return;
			const vh = window.visualViewport.height;
			this.modalEl.style.maxHeight = Math.round(vh * 0.9) + "px";
			window.setTimeout(() => {
				const focused =
					this.mode === "edit" ? this.textarea : this.mode === "confirm" ? this.confirmContainer : this.browseContainer;
				if (focused) focused.scrollIntoView({ block: "nearest" });
			}, 30);
		};
		if (window.visualViewport) {
			window.visualViewport.addEventListener("resize", this._onViewportChange);
			this._onViewportChange();
		}
		this.textarea.addEventListener("focus", this._onViewportChange);

		window.setTimeout(() => this.textarea.focus(), 10);
	}

	getTrimmedText() {
		return (this.textarea.value || "").trim();
	}

	buildHintText() {
		const s = this.plugin.settings;
		const parts = [];

		const enterIsNewline = !s.enableInbox && s.disabledInboxEnterAction === "newline";
		if (s.enableInbox) parts.push("Enter → inbox");
		else if (s.disabledInboxEnterAction === "copy") parts.push("Enter → copy entry");
		else parts.push("Enter → new line");

		parts.push("Tab → choose note");
		if (s.categories.length > 0) parts.push("↑ → categories");
		if (s.recentNoteHotkey.enabled) parts.push(`${modifierDisplayName(s.recentNoteHotkey.modifier)}+Enter → recent notes`);
		if (s.lastUsedNoteHotkey.enabled) parts.push(`${modifierDisplayName(s.lastUsedNoteHotkey.modifier)}+Enter → recently used`);
		if (!enterIsNewline) parts.push("Shift+Enter → new line");
		parts.push("Esc → discard");

		return parts.join("   ·   ");
	}

	handleKeydown(evt) {
		if (evt.key === "Escape") {
			evt.preventDefault();
			// A second Escape while the confirm screen is already showing
			// confirms the discard, instead of getting stuck doing nothing.
			if (this.mode === "confirm") this._confirmedDiscard = true;
			this.close();
			return;
		}

		// The confirm screen only responds to Escape (above) and its two buttons.
		if (this.mode === "confirm") return;

		// Both quick-jump lists ("recent" and "history") use Enter itself to
		// confirm the highlighted pick (rather than falling back to inbox
		// like it does elsewhere), so they're handled before the general
		// Enter branch below.
		if (this.mode === "recent" || this.mode === "history") {
			if (evt.key === "ArrowDown") {
				evt.preventDefault();
				this.moveHighlight(1);
				return;
			}
			if (evt.key === "ArrowUp") {
				evt.preventDefault();
				this.moveHighlight(-1);
				return;
			}
			if (evt.key === "ArrowLeft") {
				evt.preventDefault();
				this.enterEditMode();
				return;
			}
			if (evt.key === "ArrowRight" || (evt.key === "Enter" && !evt.shiftKey)) {
				evt.preventDefault();
				if (this.mode === "recent") this.selectHighlightedRecentNote();
				else this.selectHighlightedHistoryNote();
				return;
			}
			if (evt.key === "Tab" && !evt.shiftKey) {
				evt.preventDefault();
				this.handleTab();
				return;
			}
			return; // ignore other keys while browsing this list
		}

		if (evt.key === "Enter" && !evt.shiftKey) {
			const s = this.plugin.settings;

			if (s.recentNoteHotkey.enabled && matchesModifier(evt, s.recentNoteHotkey.modifier)) {
				evt.preventDefault();
				this.enterRecentNotesMode();
				return;
			}
			if (s.lastUsedNoteHotkey.enabled && matchesModifier(evt, s.lastUsedNoteHotkey.modifier)) {
				evt.preventDefault();
				this.enterHistoryMode();
				return;
			}

			if (!evt.metaKey && !evt.ctrlKey && !evt.altKey) {
				// Plain Enter, no modifiers held.
				if (!s.enableInbox && s.disabledInboxEnterAction === "newline") {
					return; // let the browser insert a normal line break, same as Shift+Enter
				}
				evt.preventDefault();
				this.handlePlainEnter();
				return;
			}
			// Some other modifier+Enter combo we don't recognize: pass through untouched.
		}

		// Tab (full vault search) stays available as a fallback in every mode,
		// including while browsing categories/files - so if the right note
		// isn't in any category, the person can always drop straight back to
		// the normal path without starting over.
		if (evt.key === "Tab" && !evt.shiftKey) {
			evt.preventDefault();
			this.handleTab();
			return;
		}

		if (this.mode === "edit") {
			if (evt.key === "ArrowUp") {
				if (this.plugin.settings.categories.length === 0) return; // let caret move normally
				evt.preventDefault();
				this.handleUpArrow();
			}
			return; // everything else (typing, Shift+Enter, caret keys): default textarea behavior
		}

		// Browsing categories or files.
		if (evt.key === "ArrowDown") {
			evt.preventDefault();
			this.moveHighlight(1);
		} else if (evt.key === "ArrowUp") {
			evt.preventDefault();
			this.moveHighlight(-1);
		} else if (evt.key === "ArrowRight") {
			evt.preventDefault();
			if (this.mode === "categories") this.enterFileMode();
			else this.selectHighlightedFile();
		} else if (evt.key === "ArrowLeft") {
			evt.preventDefault();
			if (this.mode === "categories") this.enterEditMode();
			else this.enterCategoryMode();
		}
	}

	buildBrowseFallbackHint() {
		const s = this.plugin.settings;
		let enterLabel;
		if (s.enableInbox) enterLabel = "Enter inbox";
		else if (s.disabledInboxEnterAction === "copy") enterLabel = "Enter copy entry";
		else enterLabel = "Enter n/a here"; // "newline" fallback has nothing to do while browsing (no textarea focused)
		return `Tab full search   ·   ${enterLabel}   ·   Esc discard`;
	}

	handleUpArrow() {
		if (this.submitted) return;
		if (this.plugin.settings.categories.length === 0) {
			new Notice("No categories configured yet. Add some in plugin settings.");
			return;
		}
		if (!this.getTrimmedText()) {
			new Notice("Nothing to capture yet.");
			return;
		}
		this.enterCategoryMode();
	}

	enterEditMode() {
		this.mode = "edit";
		this.browseContainer.style.display = "none";
		this.editContainer.style.display = "";
		this.textarea.focus();
	}

	enterCategoryMode() {
		this.mode = "categories";
		this.highlightIndex = Math.max(0, this.activeCategoryIndex);
		this.editContainer.style.display = "none";
		this.browseContainer.style.display = "";
		this.renderCategoryList();
		this.browseContainer.focus();
	}

	enterFileMode() {
		const categories = this.plugin.settings.categories;
		if (!categories.length) return;
		this.activeCategoryIndex = this.highlightIndex;
		const cat = categories[this.activeCategoryIndex];
		this.mode = "files";
		this.highlightIndex = 0;
		this._currentCategoryFiles = this.plugin.getCategoryFilePaths(cat);
		this.renderFileList(cat, this._currentCategoryFiles);
		this.browseContainer.focus();
	}

	renderCategoryList() {
		this.browseContainer.empty();

		const header = this.browseContainer.createDiv({ cls: "tjc-browse-header" });
		const backBtn = header.createEl("button", { cls: "tjc-btn tjc-back-btn", text: "← Back" });
		backBtn.setAttribute("aria-label", "Back to writing");
		backBtn.addEventListener("click", () => this.enterEditMode());
		header.createEl("div", { cls: "tjc-browse-title", text: "Choose a category" });

		const list = this.browseContainer.createDiv({ cls: "tjc-list" });
		this.plugin.settings.categories.forEach((cat, idx) => {
			const item = list.createDiv({ cls: "tjc-list-item", text: cat.name || "(untitled category)" });
			item.addEventListener("click", () => {
				this.highlightIndex = idx;
				this.enterFileMode();
			});
		});

		this.browseContainer.createEl("div", {
			cls: "tjc-hint",
			text: `↑↓ choose   ·   → open   ·   ← back to writing   ·   ${this.buildBrowseFallbackHint()}`,
		});
		this.updateHighlightClasses();
	}

	renderFileList(cat, files) {
		this.browseContainer.empty();

		const header = this.browseContainer.createDiv({ cls: "tjc-browse-header" });
		const backBtn = header.createEl("button", { cls: "tjc-btn tjc-back-btn", text: "← Back" });
		backBtn.setAttribute("aria-label", "Back to categories");
		backBtn.addEventListener("click", () => this.enterCategoryMode());
		header.createEl("div", { cls: "tjc-browse-title", text: cat.name || "(untitled category)" });

		if (!files.length) {
			this.browseContainer.createEl("div", { cls: "tjc-hint", text: "No notes found for this category right now." });
		} else {
			const list = this.browseContainer.createDiv({ cls: "tjc-list" });
			files.forEach((path, idx) => {
				const item = list.createDiv({ cls: "tjc-list-item", text: path });
				item.addEventListener("click", () => {
					this.highlightIndex = idx;
					this.selectHighlightedFile();
				});
			});
		}

		this.browseContainer.createEl("div", {
			cls: "tjc-hint",
			text: `↑↓ choose   ·   → select   ·   ← back to categories   ·   ${this.buildBrowseFallbackHint()}`,
		});
		this.updateHighlightClasses();
	}

	moveHighlight(delta) {
		const items = this.browseContainer.querySelectorAll(".tjc-list-item");
		if (!items.length) return;
		this.highlightIndex = (this.highlightIndex + delta + items.length) % items.length;
		this.updateHighlightClasses();
	}

	updateHighlightClasses() {
		const items = this.browseContainer.querySelectorAll(".tjc-list-item");
		items.forEach((el, idx) => {
			if (idx === this.highlightIndex) {
				el.classList.add("tjc-selected");
				el.scrollIntoView({ block: "nearest" });
			} else {
				el.classList.remove("tjc-selected");
			}
		});
	}

	async selectHighlightedFile() {
		if (this.submitted) return;
		const files = this._currentCategoryFiles || [];
		if (!files.length) return;
		const path = files[this.highlightIndex];

		const text = this.getTrimmedText();
		if (!text) {
			new Notice("Nothing to capture yet.");
			this.enterEditMode();
			return;
		}

		this.submitted = true;
		this.close();
		await this.plugin.captureToPath(path, text);
	}

	handleTab() {
		if (this.submitted) return;
		const text = this.getTrimmedText();
		if (!text) {
			new Notice("Nothing to capture yet.");
			return;
		}
		this.submitted = true;
		this.close();
		new FileSearchModal(this.app, this.plugin, text).open();
	}

	// Plain Enter (no modifiers). Only ever called when there's actually
	// something for it to do - see handleKeydown, which lets Enter pass
	// through untouched when inbox is off and the fallback is "newline".
	async handlePlainEnter() {
		if (this.submitted) return;
		const text = this.getTrimmedText();
		if (!text) {
			new Notice("Nothing to capture yet.");
			return;
		}

		if (this.plugin.settings.enableInbox) {
			this.submitted = true;
			this.close();
			await this.plugin.captureToInbox(text);
			return;
		}

		// Inbox is off and the configured fallback is "copy".
		await this.copyEntryToClipboard();
		this.submitted = true;
		this.close();
	}

	// How many recently created-or-updated notes to list. This is a quick
	// jump list, not a search - the full vault stays reachable via Tab.
	static get RECENT_NOTES_LIMIT() {
		return 25;
	}

	enterRecentNotesMode() {
		if (this.submitted) return;
		if (!this.getTrimmedText()) {
			new Notice("Nothing to capture yet.");
			return;
		}

		const files = this.app.vault.getMarkdownFiles();
		if (!files.length) {
			new Notice("No notes found in the vault.");
			return;
		}

		// Ranked by whichever is more recent, creation or last edit, so a
		// note that was just edited surfaces just as readily as a brand
		// new one.
		this._recentNotesList = files
			.slice()
			.sort((a, b) => {
				const aTime = Math.max((a.stat && a.stat.ctime) || 0, (a.stat && a.stat.mtime) || 0);
				const bTime = Math.max((b.stat && b.stat.ctime) || 0, (b.stat && b.stat.mtime) || 0);
				return bTime - aTime;
			})
			.slice(0, CaptureModal.RECENT_NOTES_LIMIT);

		this.mode = "recent";
		this.highlightIndex = 0;
		this.editContainer.style.display = "none";
		this.browseContainer.style.display = "";
		this.renderRecentNotesList();
		this.browseContainer.focus();
	}

	renderRecentNotesList() {
		this.browseContainer.empty();

		const header = this.browseContainer.createDiv({ cls: "tjc-browse-header" });
		const backBtn = header.createEl("button", { cls: "tjc-btn tjc-back-btn", text: "← Back" });
		backBtn.setAttribute("aria-label", "Back to writing");
		backBtn.addEventListener("click", () => this.enterEditMode());
		header.createEl("div", { cls: "tjc-browse-title", text: "Recent notes" });

		const list = this.browseContainer.createDiv({ cls: "tjc-list" });
		this._recentNotesList.forEach((file, idx) => {
			const item = list.createDiv({ cls: "tjc-list-item", text: file.path });
			item.addEventListener("click", () => {
				this.highlightIndex = idx;
				this.selectHighlightedRecentNote();
			});
		});

		this.browseContainer.createEl("div", {
			cls: "tjc-hint",
			text: `↑↓ choose   ·   Enter/→ select   ·   ← back to writing   ·   ${this.buildBrowseFallbackHint()}`,
		});
		this.updateHighlightClasses();
	}

	async selectHighlightedRecentNote() {
		if (this.submitted) return;
		const files = this._recentNotesList || [];
		if (!files.length) return;
		const file = files[this.highlightIndex];

		const text = this.getTrimmedText();
		if (!text) {
			new Notice("Nothing to capture yet.");
			this.enterEditMode();
			return;
		}

		this.submitted = true;
		this.close();
		await this.plugin.captureToFile(file, text);
	}

	enterHistoryMode() {
		if (this.submitted) return;
		if (!this.getTrimmedText()) {
			new Notice("Nothing to capture yet.");
			return;
		}

		const history = this.plugin.settings.usedFileHistory || [];
		if (!history.length) {
			new Notice("No previously used notes yet.");
			return;
		}

		this._historyList = history.slice();
		this.mode = "history";
		this.highlightIndex = 0;
		this.editContainer.style.display = "none";
		this.browseContainer.style.display = "";
		this.renderHistoryList();
		this.browseContainer.focus();
	}

	renderHistoryList() {
		this.browseContainer.empty();

		const header = this.browseContainer.createDiv({ cls: "tjc-browse-header" });
		const backBtn = header.createEl("button", { cls: "tjc-btn tjc-back-btn", text: "← Back" });
		backBtn.setAttribute("aria-label", "Back to writing");
		backBtn.addEventListener("click", () => this.enterEditMode());
		header.createEl("div", { cls: "tjc-browse-title", text: "Recently used notes" });

		const list = this.browseContainer.createDiv({ cls: "tjc-list" });
		this._historyList.forEach((path, idx) => {
			const item = list.createDiv({ cls: "tjc-list-item", text: path });
			item.addEventListener("click", () => {
				this.highlightIndex = idx;
				this.selectHighlightedHistoryNote();
			});
		});

		this.browseContainer.createEl("div", {
			cls: "tjc-hint",
			text: `↑↓ choose   ·   Enter/→ select   ·   ← back to writing   ·   ${this.buildBrowseFallbackHint()}`,
		});
		this.updateHighlightClasses();
	}

	async selectHighlightedHistoryNote() {
		if (this.submitted) return;
		const history = this._historyList || [];
		if (!history.length) return;
		const path = history[this.highlightIndex];

		const text = this.getTrimmedText();
		if (!text) {
			new Notice("Nothing to capture yet.");
			this.enterEditMode();
			return;
		}

		this.submitted = true;
		this.close();
		await this.plugin.captureToPath(path, text);
	}

	async copyEntryToClipboard() {
		const text = this.getTrimmedText();
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			new Notice("Entry copied to clipboard.");
		} catch (e) {
			console.error("Themed Journal Capture: failed to copy to clipboard", e);
			new Notice("Themed Journal Capture: couldn't copy to clipboard.");
		}
	}

	// Overrides Modal.close(). Every path that closes this modal - Escape,
	// the built-in ✕ button, clicking outside, or our own code - calls
	// this.close(), so intercepting it here covers all of them uniformly.
	// A successful capture always sets this.submitted before calling
	// close(), so it's never held up by the confirmation screen.
	close() {
		const hasUnsavedText = this.textarea && this.getTrimmedText().length > 0;
		if (!this.submitted && this.plugin.settings.confirmBeforeDiscard && !this._confirmedDiscard && hasUnsavedText) {
			if (this.mode !== "confirm") this.showConfirmScreen();
			return;
		}
		super.close();
	}

	showConfirmScreen() {
		this.mode = "confirm";
		this.editContainer.style.display = "none";
		this.browseContainer.style.display = "none";

		if (!this.confirmContainer) {
			this.confirmContainer = this.contentEl.createDiv({ cls: "tjc-confirm-container" });
			this.confirmContainer.setAttribute("tabindex", "-1");
		}
		this.confirmContainer.empty();
		this.confirmContainer.style.display = "";

		this.confirmContainer.createEl("div", { cls: "tjc-browse-title", text: "Discard this entry?" });
		this.confirmContainer.createEl("div", { cls: "tjc-hint", text: "It hasn't been saved anywhere yet." });

		const btnRow = this.confirmContainer.createDiv({ cls: "tjc-btn-row" });

		const yesCancelBtn = btnRow.createEl("button", { text: "Yes, cancel", cls: "tjc-btn" });
		yesCancelBtn.addEventListener("click", () => {
			this._confirmedDiscard = true;
			this.close();
		});

		const copyBtn = btnRow.createEl("button", { text: "Copy entry to clipboard", cls: "tjc-btn tjc-btn-primary" });
		copyBtn.addEventListener("click", async () => {
			await this.copyEntryToClipboard();
			this._confirmedDiscard = true;
			this.close();
		});

		this.confirmContainer.focus();
	}

	onClose() {
		if (window.visualViewport && this._onViewportChange) {
			window.visualViewport.removeEventListener("resize", this._onViewportChange);
		}
		this.contentEl.empty();
	}
}

class FileSearchModal extends FuzzySuggestModal {
	constructor(app, plugin, text) {
		super(app);
		this.plugin = plugin;
		this.text = text;
		this.setPlaceholder("Choose a note for this entry…");
	}

	getItems() {
		return this.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(item) {
		return item.path;
	}

	onChooseItem(item) {
		this.plugin.captureToFile(item, this.text);
	}
}

class ThemedJournalCaptureSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Themed Journal Capture" });

		new Setting(containerEl)
			.setName("Heading")
			.setDesc("The exact heading line entries are filed under (created automatically at the top of a note if missing). Include the markdown syntax, e.g. \"## Journal\".")
			.addText((text) =>
				text
					.setPlaceholder("## Journal")
					.setValue(this.plugin.settings.heading)
					.onChange(async (value) => {
						this.plugin.settings.heading = value.trim() || DEFAULT_SETTINGS.heading;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Bullet points")
			.setDesc("On: each entry is inserted as a markdown bullet (\"- \"). Off: entries are inserted as plain lines with no bullet marker.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useBullet).onChange(async (value) => {
					this.plugin.settings.useBullet = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Timestamp")
			.setDesc("What to prepend to each bullet after the dash.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("none", "None")
					.addOption("date", "Date (YYYY-MM-DD)")
					.addOption("datetime", "Date & time (YYYY-MM-DDTHH:mm)")
					.setValue(this.plugin.settings.dateFormat)
					.onChange(async (value) => {
						this.plugin.settings.dateFormat = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Inbox note")
			.setDesc("Lets Enter route entries to an inbox note. Turn off if you don't use one - the \"Send to inbox\" button disappears and you choose what plain Enter does instead.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableInbox).onChange(async (value) => {
					this.plugin.settings.enableInbox = value;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (this.plugin.settings.enableInbox) {
			new Setting(containerEl)
				.setName("Inbox note path")
				.setDesc("Path used when you press Enter. Created automatically, including any missing parent folders, if it doesn't exist.")
				.addText((text) =>
					text
						.setPlaceholder("Inbox.md")
						.setValue(this.plugin.settings.inboxPath)
						.onChange(async (value) => {
							this.plugin.settings.inboxPath = value.trim() || DEFAULT_SETTINGS.inboxPath;
							await this.plugin.saveSettings();
						})
				);
		} else {
			new Setting(containerEl)
				.setName("When inbox is off, Enter should")
				.setDesc("There's no inbox to send to, so pick what plain Enter does instead.")
				.addDropdown((dropdown) =>
					dropdown
						.addOption("copy", "Copy the entry to the clipboard")
						.addOption("newline", "Just insert a line break (default textarea behavior)")
						.setValue(this.plugin.settings.disabledInboxEnterAction)
						.onChange(async (value) => {
							this.plugin.settings.disabledInboxEnterAction = value;
							await this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl)
			.setName("Confirm before discarding")
			.setDesc("Ask before abandoning an entry (Escape, the ✕ button, or clicking outside), with an option to copy it to the clipboard first instead of losing it.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.confirmBeforeDiscard).onChange(async (value) => {
					this.plugin.settings.confirmBeforeDiscard = value;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("h3", { text: "Categories" });
		containerEl.createEl("p", {
			cls: "tjc-hint",
			text: "Optional. Group frequently used notes under named categories, browsable from the capture window with ↑ (open categories), → (open a category / select a file), ← (back).",
		});

		this.plugin.settings.categories.forEach((cat, idx) => {
			const block = containerEl.createDiv({ cls: "tjc-category-block" });

			new Setting(block)
				.setName(`Category ${idx + 1}`)
				.addText((text) =>
					text
						.setPlaceholder("Category name")
						.setValue(cat.name)
						.onChange(async (value) => {
							cat.name = value;
							await this.plugin.saveSettings();
						})
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Remove this category")
						.onClick(async () => {
							this.plugin.settings.categories.splice(idx, 1);
							await this.plugin.saveSettings();
							this.display();
						})
				);

			new Setting(block)
				.setName("Source")
				.setDesc("What determines which notes show up in this category.")
				.addDropdown((dropdown) =>
					dropdown
						.addOption("files", "Manual list of notes")
						.addOption("folder", "All notes in a folder")
						.addOption("tag", "All notes with a tag")
						.addOption("property", "All notes with a property value")
						.addOption("bookmarks", "All bookmarked notes")
						.setValue(cat.sourceType)
						.onChange(async (value) => {
							cat.sourceType = value;
							await this.plugin.saveSettings();
							this.display();
						})
				);

			if (cat.sourceType === "folder") {
				new Setting(block)
					.setName("Folder")
					.setDesc("Vault path to a folder, e.g. Projects/Work. Includes notes in subfolders.")
					.addText((text) =>
						text
							.setPlaceholder("Projects/Work")
							.setValue(cat.folderPath)
							.onChange(async (value) => {
								cat.folderPath = value.trim();
								await this.plugin.saveSettings();
							})
					);
			} else if (cat.sourceType === "tag") {
				new Setting(block)
					.setName("Tag")
					.setDesc("With or without the #, e.g. journal or #journal. Matches the tag anywhere in the note (frontmatter or inline).")
					.addText((text) =>
						text
							.setPlaceholder("journal")
							.setValue(cat.tag)
							.onChange(async (value) => {
								cat.tag = value.trim();
								await this.plugin.saveSettings();
							})
					);
			} else if (cat.sourceType === "property") {
				new Setting(block)
					.setName("Property")
					.setDesc("The frontmatter property name, e.g. status.")
					.addText((text) =>
						text
							.setPlaceholder("status")
							.setValue(cat.propertyKey)
							.onChange(async (value) => {
								cat.propertyKey = value.trim();
								await this.plugin.saveSettings();
							})
					);
				new Setting(block)
					.setName("Value")
					.setDesc("The value that property must equal, e.g. active. Also matches if the property is a list containing this value.")
					.addText((text) =>
						text
							.setPlaceholder("active")
							.setValue(cat.propertyValue)
							.onChange(async (value) => {
								cat.propertyValue = value.trim();
								await this.plugin.saveSettings();
							})
					);
			} else if (cat.sourceType === "bookmarks") {
				block.createEl("p", {
					cls: "tjc-hint",
					text: "Uses whatever notes are currently in Obsidian's core Bookmarks plugin (file bookmarks only — bookmarked folders, searches, etc. are ignored).",
				});
			} else {
				new Setting(block)
					.setName("Files")
					.setDesc("One vault path per line, e.g. People/John.md. Created automatically if a path doesn't exist yet.")
					.addTextArea((text) => {
						text.setValue(cat.files.join("\n")).onChange(async (value) => {
							cat.files = value
								.split("\n")
								.map((s) => s.trim())
								.filter(Boolean);
							await this.plugin.saveSettings();
						});
						text.inputEl.rows = 4;
						text.inputEl.addClass("tjc-category-files");
					});
			}
		});

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("+ Add category")
				.onClick(async () => {
					this.plugin.settings.categories.push({
						name: "New category",
						sourceType: "files",
						files: [],
						folderPath: "",
						tag: "",
						propertyKey: "",
						propertyValue: "",
					});
					await this.plugin.saveSettings();
					this.display();
				})
		);

		containerEl.createEl("h3", { text: "Quick-jump hotkeys" });
		containerEl.createEl("p", {
			cls: "tjc-hint",
			text: "Optional. Each adds a modifier+Enter shortcut inside the capture window (plus a tap button on mobile), opening a short ranked list to pick from - one ranked by when notes were created or edited, the other by when you last used them with this plugin.",
		});

		new Setting(containerEl)
			.setName("Recent notes list")
			.setDesc(
				`Opens a list of your ${CaptureModal.RECENT_NOTES_LIMIT} most recently created or updated notes, newest first. Navigate with ↑/↓, confirm with Enter or →.`
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.recentNoteHotkey.enabled).onChange(async (value) => {
					this.plugin.settings.recentNoteHotkey.enabled = value;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (this.plugin.settings.recentNoteHotkey.enabled) {
			new Setting(containerEl).setName("Modifier").addDropdown((dropdown) =>
				dropdown
					.addOption("Meta", modifierDisplayName("Meta"))
					.addOption("Ctrl", modifierDisplayName("Ctrl"))
					.addOption("Alt", modifierDisplayName("Alt"))
					.setValue(this.plugin.settings.recentNoteHotkey.modifier)
					.onChange(async (value) => {
						this.plugin.settings.recentNoteHotkey.modifier = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);
		}

		new Setting(containerEl)
			.setName("Recently used notes list")
			.setDesc(
				`Opens a list of up to ${USED_FILE_HISTORY_LIMIT} notes this plugin has filed entries into, most recently used first. Using a note again moves it back to the top.`
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.lastUsedNoteHotkey.enabled).onChange(async (value) => {
					this.plugin.settings.lastUsedNoteHotkey.enabled = value;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (this.plugin.settings.lastUsedNoteHotkey.enabled) {
			new Setting(containerEl).setName("Modifier").addDropdown((dropdown) =>
				dropdown
					.addOption("Meta", modifierDisplayName("Meta"))
					.addOption("Ctrl", modifierDisplayName("Ctrl"))
					.addOption("Alt", modifierDisplayName("Alt"))
					.setValue(this.plugin.settings.lastUsedNoteHotkey.modifier)
					.onChange(async (value) => {
						this.plugin.settings.lastUsedNoteHotkey.modifier = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);
		}

		if (
			this.plugin.settings.recentNoteHotkey.enabled &&
			this.plugin.settings.lastUsedNoteHotkey.enabled &&
			this.plugin.settings.recentNoteHotkey.modifier === this.plugin.settings.lastUsedNoteHotkey.modifier
		) {
			containerEl.createEl("p", {
				cls: "tjc-hint",
				text: `Both are set to ${modifierDisplayName(
					this.plugin.settings.recentNoteHotkey.modifier
				)}+Enter - the recent-notes list will take priority over the keyboard shortcut, and the recently-used list will only be reachable by its tap button until you pick a different modifier for one of them.`,
			});
		}

		containerEl.createEl("p", {
			cls: "tjc-hint",
			text: "Tip: bind a hotkey to \"Themed Journal Capture: Open capture window\" in Settings → Hotkeys.",
		});
	}
}

module.exports = class ThemedJournalCapturePlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "open-capture-window",
			name: "Open capture window",
			callback: () => {
				new CaptureModal(this.app, this).open();
			},
		});

		this.addSettingTab(new ThemedJournalCaptureSettingTab(this.app, this));
	}

	async loadSettings() {
		const loaded = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		this.settings.categories = Array.isArray(this.settings.categories)
			? this.settings.categories.map((c) => ({
					name: (c && c.name) || "",
					sourceType: (c && c.sourceType) || "files",
					files: Array.isArray(c && c.files) ? c.files.slice() : [],
					folderPath: (c && c.folderPath) || "",
					tag: (c && c.tag) || "",
					propertyKey: (c && c.propertyKey) || "",
					propertyValue: (c && c.propertyValue) || "",
			  }))
			: [];
		this.settings.recentNoteHotkey = Object.assign({ enabled: false, modifier: "Meta" }, this.settings.recentNoteHotkey || {});
		this.settings.lastUsedNoteHotkey = Object.assign({ enabled: false, modifier: "Ctrl" }, this.settings.lastUsedNoteHotkey || {});

		if (Array.isArray(this.settings.usedFileHistory)) {
			this.settings.usedFileHistory = this.settings.usedFileHistory.slice(0, USED_FILE_HISTORY_LIMIT);
		} else if (typeof loaded.lastUsedFilePath === "string" && loaded.lastUsedFilePath) {
			// Migrating from the pre-history single-path version of this setting.
			this.settings.usedFileHistory = [loaded.lastUsedFilePath];
		} else {
			this.settings.usedFileHistory = [];
		}
		delete this.settings.lastUsedFilePath;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	formatBullet(rawText) {
		const stamp = formatTimestamp(this.settings.dateFormat);

		if (!this.settings.useBullet) {
			// No bullet marker, so no need to indent continuation lines either.
			return stamp ? `${stamp} ${rawText}` : rawText;
		}

		// Indent continuation lines so multi-line entries stay part of one bullet.
		const indented = rawText
			.split("\n")
			.map((line, idx) => (idx === 0 ? line : "  " + line))
			.join("\n");
		return stamp ? `- ${stamp} ${indented}` : `- ${indented}`;
	}

	// Resolves a category's live list of note paths based on its source type.
	// Computed fresh every time a category is opened, so folder/tag/property/
	// bookmark categories always reflect the vault's current state.
	getCategoryFilePaths(cat) {
		const type = cat.sourceType || "files";
		if (type === "folder") return this.getFilesInFolder(cat.folderPath);
		if (type === "tag") return this.getFilesWithTag(cat.tag);
		if (type === "property") return this.getFilesWithProperty(cat.propertyKey, cat.propertyValue);
		if (type === "bookmarks") return this.getBookmarkedFiles();
		return Array.isArray(cat.files) ? cat.files.slice() : [];
	}

	getFilesInFolder(folderPath) {
		const normalized = normalizePath((folderPath || "").trim()).replace(/\/+$/, "");
		if (!normalized) return [];
		const prefix = normalized + "/";
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix))
			.map((f) => f.path)
			.sort();
	}

	getFilesWithTag(tag) {
		let target = (tag || "").trim();
		if (!target) return [];
		if (!target.startsWith("#")) target = "#" + target;
		target = target.toLowerCase();

		const results = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(f);
			if (!cache) continue;
			const tags = getAllTags(cache) || [];
			if (tags.some((t) => t.toLowerCase() === target)) results.push(f.path);
		}
		return results.sort();
	}

	getFilesWithProperty(key, value) {
		const k = (key || "").trim();
		const v = (value || "").trim();
		if (!k) return [];

		const results = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(f);
			const fm = cache && cache.frontmatter;
			if (!fm || !(k in fm)) continue;
			const fv = fm[k];
			if (Array.isArray(fv)) {
				if (fv.some((x) => String(x) === v)) results.push(f.path);
			} else if (String(fv) === v) {
				results.push(f.path);
			}
		}
		return results.sort();
	}

	getBookmarkedFiles() {
		const bookmarksPlugin = this.app.internalPlugins && this.app.internalPlugins.getPluginById
			? this.app.internalPlugins.getPluginById("bookmarks")
			: null;
		if (!bookmarksPlugin || !bookmarksPlugin.enabled || !bookmarksPlugin.instance) return [];

		const items = bookmarksPlugin.instance.items || [];
		const results = [];
		const walk = (list) => {
			for (const item of list) {
				if (item.type === "file" && item.path) results.push(item.path);
				else if (item.type === "group" && Array.isArray(item.items)) walk(item.items);
			}
		};
		walk(items);

		const markdownPaths = new Set(this.app.vault.getMarkdownFiles().map((f) => f.path));
		return Array.from(new Set(results.filter((p) => markdownPaths.has(p)))).sort();
	}

	async resolveOrCreateFile(rawPath) {
		let path = normalizePath(rawPath);
		if (!path.toLowerCase().endsWith(".md")) path += ".md";

		let file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) return file;

		const folder = path.substring(0, path.lastIndexOf("/"));
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
			try {
				await this.app.vault.createFolder(folder);
			} catch (e) {
				// Folder may already exist due to a race; ignore.
			}
		}
		return await this.app.vault.create(path, "");
	}

	// Returns the line index right after a leading "---\n...\n---" frontmatter
	// block, or 0 if the file has no frontmatter (or it's unterminated).
	frontmatterEndIndex(lines) {
		if (lines.length === 0 || lines[0].trim() !== "---") return 0;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === "---") return i + 1;
		}
		return 0;
	}

	async insertUnderHeading(file, rawText) {
		const heading = this.settings.heading.trim();
		const bullet = this.formatBullet(rawText);

		const content = await this.app.vault.read(file);
		const lines = content.length ? content.split("\n") : [];
		const headingIdx = lines.findIndex((line) => line.trim() === heading);

		let newLines;
		if (headingIdx === -1) {
			// Heading is missing: add it, but never above frontmatter/properties -
			// insert right after the closing "---" if there is one.
			const insertAt = this.frontmatterEndIndex(lines);
			const before = lines.slice(0, insertAt);
			const after = lines.slice(insertAt);
			const block = [heading, bullet, ""];
			newLines = insertAt > 0 ? [...before, "", ...block, ...after] : [...block, ...after];
		} else {
			newLines = lines.slice();
			newLines.splice(headingIdx + 1, 0, bullet);
		}

		await this.app.vault.modify(file, newLines.join("\n"));
	}

	// Moves path to the front of usedFileHistory (removing any earlier
	// occurrence first, so re-using a note bumps it back to the top
	// instead of appearing twice), capped at USED_FILE_HISTORY_LIMIT.
	recordUsedFile(path) {
		const history = (this.settings.usedFileHistory || []).filter((p) => p !== path);
		history.unshift(path);
		this.settings.usedFileHistory = history.slice(0, USED_FILE_HISTORY_LIMIT);
	}

	async captureToFile(file, rawText) {
		try {
			await this.insertUnderHeading(file, rawText);
			this.recordUsedFile(file.path);
			await this.saveSettings();
			new Notice(`Captured to "${file.basename}".`);
		} catch (e) {
			console.error("Themed Journal Capture: failed to write entry", e);
			new Notice("Themed Journal Capture: failed to save entry. See console for details.");
		}
	}

	async captureToPath(rawPath, rawText) {
		let file;
		try {
			file = await this.resolveOrCreateFile(rawPath);
		} catch (e) {
			console.error("Themed Journal Capture: failed to resolve category file", e);
			new Notice(`Themed Journal Capture: couldn't open or create "${rawPath}".`);
			return;
		}
		await this.captureToFile(file, rawText);
	}

	async captureToInbox(rawText) {
		try {
			const file = await this.resolveOrCreateFile(this.settings.inboxPath);
			await this.insertUnderHeading(file, rawText);
			new Notice(`Captured to inbox ("${file.basename}").`);
		} catch (e) {
			console.error("Themed Journal Capture: failed to write entry to inbox", e);
			new Notice("Themed Journal Capture: failed to save entry to inbox. See console for details.");
		}
	}
};
