# Themed Journal Capture

A frictionless quick-capture modal for Obsidian. Trigger it with a hotkey from anywhere, write a note, and file it — as a dated bullet — into any note you choose, or straight into your inbox.

## Install

1. Copy `main.js`, `manifest.json`, and `styles.css` into a new folder in your vault:
   `<vault>/.obsidian/plugins/themed-journal-capture/`
2. Reload Obsidian (or disable/re-enable community plugins).
3. Enable **Themed Journal Capture** under Settings → Community plugins.
4. Go to Settings → Hotkeys, search for **"Themed Journal Capture: Open capture window"**, and bind a hotkey to it. (No default hotkey is set, so this step is required — pick whatever's easiest to hit from anywhere, e.g. on iOS/iPadOS you can trigger commands via Shortcuts or the mobile toolbar.)

No build step needed — it's plain JS, ready to run as-is.

## How it works

1. Trigger your hotkey → an empty capture window opens with room for several sentences.
2. Write your entry.
3. Decide where it goes:
   - **Tab** (or tap **"Choose note…"**) → opens a fuzzy search over every markdown file in the vault. Pick one, and the entry is filed there.
   - **Enter without Shift** (or tap the button that appears for it) → what this does depends on the "Inbox note" setting:
     - Inbox **on** (default) → tap **"Send to inbox"** or press Enter to send it straight to your configured inbox note.
     - Inbox **off**, fallback set to **copy** (default when inbox is off) → tap **"Copy entry"** or press Enter to copy the entry to the clipboard and close the window, so it's never lost even with no inbox to catch it.
     - Inbox **off**, fallback set to **line break** → Enter just inserts a normal newline, same as Shift+Enter; no button is shown since there's nothing to tap.
   - **↑ (Up arrow)** (or tap **"Categories…"**, shown once you've configured at least one) → opens your configured categories. From there:
     - **↑ / ↓** move between categories (or files, once inside one).
     - **→** opens the highlighted category, or selects the highlighted file (same result as picking it via Tab).
     - **←**, or tap the **"← Back"** button, goes back a level — from a file list to the category list, or from the category list back to writing. The tap button exists because most mobile on-screen keyboards don't have a left arrow key.
     - **Tab** and **Enter** still work as fallbacks from anywhere in the category browser, so if the note you want isn't listed in any category, you're never stuck.
   - **Modifier+Enter** (or the matching tap button), if you've turned these on in settings:
     - **"Recent notes list"** → opens a list of your 25 most recently created or updated notes, newest at the top. Navigate with **↑ / ↓**, then **Enter** or **→** files the entry into whichever one is highlighted. **←** goes back to writing without picking anything.
     - **"Recently used notes list"** → opens a list of up to 25 notes this plugin has filed entries into before, most recently used at the top. Same navigation as the recent-notes list above. Using a note again moves it back to the top of this list.
     - Each has its own configurable modifier — Cmd, Control, or Option/Alt — so pick whichever doesn't clash with something else on your system. Off by default.
   - **Shift+Enter** → inserts a normal newline, so multi-line entries work fine (continuation lines are indented so they stay part of the same bullet).
   - **Escape**, the modal's **✕** close button, or clicking outside the window → abandons the entry. If "Confirm before discarding" is on (default) *and* you've actually written something, you'll first see a small screen with two choices: **"Yes, cancel"** (discards for real) or **"Copy entry to clipboard"** (copies it, then closes) — press Escape again to confirm discarding without touching the mouse/keyboard focus. An empty capture window always closes immediately, with no confirmation, regardless of this setting. Turn the setting off to go back to instant discarding even with text present.

Either way, the entry is inserted as:

```
- 2026-07-04 your entry text here
```

(or without the leading `- ` if you've turned bullet points off in settings) right below the configured heading. If the heading doesn't exist yet in the target note, it's created at the top of the file, so the newest entry is always the first thing under it.

## Settings

- **Heading** — the exact heading line entries are filed under, including markdown syntax (default `## Journal`).
- **Bullet points** — on by default. Turn off to insert entries as plain lines instead of markdown bullets.
- **Timestamp** — `None`, `Date` (`YYYY-MM-DD`), or `Date & time` (`YYYY-MM-DDTHH:mm`), prepended to each entry.
- **Inbox note** — on by default. Turning it off hides the "Send to inbox" button and lets you choose what plain Enter does instead (copy to clipboard, or just insert a line break). When on, set the **Inbox note path** (default `Inbox.md`) — created automatically, including any missing parent folders, if it doesn't exist.
- **Confirm before discarding** — on by default. See the Escape/✕ behavior above.
- **Categories** — optional. Browsable from the capture window via ↑ → ←. Add/remove categories with the buttons in this settings tab. Each category picks its notes one of five ways:
  - **Manual list of notes** — type vault paths, one per line. Files are created automatically (like the inbox note) if they don't already exist.
  - **All notes in a folder** — give a folder path; every note inside it (including subfolders) counts.
  - **All notes with a tag** — give a tag, with or without the `#`; matches the tag whether it's in frontmatter or inline in the note.
  - **All notes with a property value** — give a frontmatter property name and the value it must equal; also matches if that property is a list containing the value.
  - **All bookmarked notes** — uses whatever's currently in Obsidian's core Bookmarks plugin (file bookmarks only).

  The four dynamic types (folder/tag/property/bookmarks) are computed live every time you open that category — add a note to the folder, tag, property, or bookmarks, and it shows up next time without touching plugin settings. Unlike the manual list, these never auto-create a missing file — they only ever show notes that already exist.

  Note: when at least one category is configured, the Up arrow in the capture window is repurposed to open the category browser instead of moving the text caret up a line. If you don't use categories, leave the list empty and Up arrow behaves as normal caret movement.

- **Quick-jump hotkeys** — off by default. Two independent toggles, each with its own modifier (Cmd/Control/Option) for a modifier+Enter shortcut inside the capture window, plus a matching tap button:
  - **Recent notes list** — opens a browsable list (25 most recently created/updated notes, newest first) rather than picking one automatically.
  - **Recently used notes list** — ranked by when you last used each note with this plugin (not by file dates). Re-using a note moves it back to the top.

  If you enable both with the same modifier, the recent-notes list takes priority over the keyboard shortcut — a note in settings will say so — but both tap buttons still work regardless.

## Changelog

- **1.3.0** — Inbox note can now be turned off entirely (with a choice of what Enter does instead: copy to clipboard, or a plain line break). Added two optional quick-jump hotkeys, each opening a ranked list to pick from: one by when notes were created/edited, the other by when you last used them with this plugin. Added an optional confirmation screen before discarding an entry (when you click outside the journal capture window), with a "copy to clipboard" escape hatch.
- **1.2.0** — Added a toggle to turn bullet points off entirely. Categories can now pull their notes live from a folder, a tag, a frontmatter property value, or Obsidian's Bookmarks, instead of only a manually typed list.
- **1.1.0** — Added a tappable "← Back" button to the category and file browser screens, so going back a level doesn't require a physical left-arrow key on mobile.
- **1.0.0** — Initial release.
