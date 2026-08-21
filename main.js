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

const { Plugin, Modal, FuzzySuggestModal, PluginSettingTab, Setting, Notice, TFile, normalizePath, getAllTags } = require("obsidian");

const DEFAULT_SETTINGS = {
	heading: "## Journal",
	dateFormat: "date", // "none" | "date" | "datetime"
	useBullet: true,
	inboxPath: "Inbox.md",
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

class CaptureModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
		this.submitted = false;
		this.mode = "edit"; // "edit" | "categories" | "files"
		this.activeCategoryIndex = -1;
		this.highlightIndex = 0;
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
		hint.setText("Enter → inbox   ·   Tab → choose note   ·   ↑ → categories   ·   Shift+Enter → new line   ·   Esc → discard");

		const btnRow = this.editContainer.createDiv({ cls: "tjc-btn-row" });

		const inboxBtn = btnRow.createEl("button", { text: "Send to inbox", cls: "tjc-btn tjc-btn-primary" });
		inboxBtn.addEventListener("click", () => this.handleEnterToInbox());

		const chooseBtn = btnRow.createEl("button", { text: "Choose note…", cls: "tjc-btn" });
		chooseBtn.addEventListener("click", () => this.handleTab());

		if (this.plugin.settings.categories.length > 0) {
			const categoriesBtn = btnRow.createEl("button", { text: "Categories…", cls: "tjc-btn" });
			categoriesBtn.addEventListener("click", () => this.handleUpArrow());
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
				const focused = this.mode === "edit" ? this.textarea : this.browseContainer;
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

	handleKeydown(evt) {
		if (evt.key === "Escape") {
			evt.preventDefault();
			this.close();
			return;
		}

		// Tab (full vault search) and Enter (inbox) stay available as
		// fallbacks in every mode, including while browsing categories/files -
		// so if the right note isn't in any category, the person can always
		// drop straight back to the normal path without starting over.
		if (evt.key === "Tab" && !evt.shiftKey) {
			evt.preventDefault();
			this.handleTab();
			return;
		}
		if (evt.key === "Enter" && !evt.shiftKey) {
			evt.preventDefault();
			this.handleEnterToInbox();
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
			text: "↑↓ choose   ·   → open   ·   ← back to writing   ·   Tab full search   ·   Enter inbox   ·   Esc discard",
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
			text: "↑↓ choose   ·   → select   ·   ← back to categories   ·   Tab full search   ·   Enter inbox   ·   Esc discard",
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

	async handleEnterToInbox() {
		if (this.submitted) return;
		const text = this.getTrimmedText();
		if (!text) {
			new Notice("Nothing to capture yet.");
			return;
		}
		this.submitted = true;
		this.close();
		await this.plugin.captureToInbox(text);
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
			.setDesc("Path to the note used when you press Enter instead of Tab. Created automatically if it doesn't exist.")
			.addText((text) =>
				text
					.setPlaceholder("Inbox.md")
					.setValue(this.plugin.settings.inboxPath)
					.onChange(async (value) => {
						this.plugin.settings.inboxPath = value.trim() || DEFAULT_SETTINGS.inboxPath;
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

	async captureToFile(file, rawText) {
		try {
			await this.insertUnderHeading(file, rawText);
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
