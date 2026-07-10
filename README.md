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
   - **Enter without Shift** (or tap **"Send to inbox"**) → the entry goes straight to your configured inbox note.
   - **↑ (Up arrow)** (or tap **"Categories…"**, shown once you've configured at least one) → opens your configured categories. From there:
     - **↑ / ↓** move between categories (or files, once inside one).
     - **→** opens the highlighted category, or selects the highlighted file (same result as picking it via Tab).
     - **←** goes back a level — from a file list to the category list, or from the category list back to writing.
     - **Tab** and **Enter** still work as fallbacks from anywhere in the category browser, so if the note you want isn't listed in any category, you're never stuck — you can drop straight into the full vault search or the inbox.
   - **Shift+Enter** → inserts a normal newline, so multi-line entries work fine (continuation lines are indented so they stay part of the same bullet).
   - **Escape** or the modal's **✕** close button → discards the entry. Nothing is written anywhere.

Either way, the entry is inserted as:

```
- 2026-07-04 your entry text here
```

right below the configured heading. If the heading doesn't exist yet in the target note, it's created at the top of the file, so the newest entry is always the first thing under it.

## Settings

- **Heading** — the exact heading line entries are filed under, including markdown syntax (default `## Journal`).
- **Timestamp** — `None`, `Date` (`YYYY-MM-DD`), or `Date & time` (`YYYY-MM-DDTHH:mm`), prepended to each bullet.
- **Inbox note** — path used when you press Enter instead of Tab (default `Inbox.md`). Created automatically, including any missing parent folders, if it doesn't exist.
- **Categories** — optional. Each category has a name and a list of vault file paths (one per line). Browsable from the capture window via ↑ → ←. Add/remove categories with the buttons in this settings tab; files listed under a category are created automatically (like the inbox note) if they don't already exist.

Note: when at least one category is configured, the Up arrow in the capture window is repurposed to open the category browser instead of moving the text caret up a line. If you don't use categories, leave the list empty and Up arrow behaves as normal caret movement.

## Before publishing / sharing

`manifest.json` still has placeholder values for `author` and `authorUrl` — fill those in with your name/handle and GitHub URL before submitting to the community plugin directory or sharing the repo.
