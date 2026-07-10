# Publishing checklist

Everything file-level is done: `manifest.json`, `main.js`, `styles.css`, `README.md`, `LICENSE`, `versions.json`, and a release workflow at `.github/workflows/release.yml` that automates step 3 below. What's left are actions on GitHub itself, which only you can do (they require your account).

## Before anything else

Everything is filled in now — `manifest.json` (`author: "Sharfaroz"`, `authorUrl: "https://github.com/sharfaroz"`) and `LICENSE` match the convention from your `wikilinkcopy` plugin. Double-check one thing: `wikilinkcopy`'s `authorUrl` points to `github.com/sharfaroz`, but the repo itself lives under `github.com/sharfaroz7` — if that's intentional (a separate primary profile), no action needed; if it was a typo carried over, let me know and I'll fix both.

## Steps

1. **Create a public GitHub repository** and push these files to its root (not a subfolder) — `main.js`, `manifest.json`, `styles.css`, `README.md`, `LICENSE`, `versions.json`, `.github/workflows/release.yml`.

2. **Tag a release matching `manifest.json`'s version:**
   ```
   git tag 1.0.0
   git push origin 1.0.0
   ```
   With the workflow in place, this alone creates the GitHub Release with the three required files attached as individual assets. (If you'd rather not use the workflow, you can instead go to GitHub → Releases → "Draft a new release," use `1.0.0` as the tag with no `v` prefix, and manually attach `main.js`, `manifest.json`, and `styles.css` as binary attachments.)

3. **Fork [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases)** and add an entry to the end of `community-plugins.json`:
   ```json
   {
   	"id": "themed-journal-capture",
   	"name": "Themed Journal Capture",
   	"author": "Sharfaroz",
   	"description": "Capture a quick journal entry from anywhere, then file it as a dated bullet under a heading in any note (or send it straight to your inbox note).",
   	"repo": "sharfaroz7/themed-journal-capture"
   }
   ```
   (Don't forget a trailing comma after the previous entry in the file. Adjust the `repo` value if you end up naming the GitHub repository something other than `themed-journal-capture`.)

4. **Open a pull request** to `obsidianmd/obsidian-releases`. GitHub will load a PR template with a checklist — check off each item honestly (tested platforms, README completeness, developer policies read, license present, etc.). An automated bot validates the submission within a few minutes and comments with any issues to fix.

5. Once the bot's checks pass, it's queued for human review. Only an Obsidian team member can merge it, so timing varies.

## Things already verified against the current submission rules

- `manifest.json` id (`themed-journal-capture`) contains no "obsidian" and uses only lowercase/digits/hyphens.
- `name` and `description` contain no "Obsidian" or "Plugin".
- `description` is 145 characters (well under the 250 limit) and ends with a period.
- `isDesktopOnly: false` is accurate — the plugin only uses the standard Vault/App API, no Node.js/Electron-only modules.
- No `console.log` calls anywhere; only `console.error` inside catch blocks, which is allowed.
- The code uses `this.app` throughout, never the global `app`.
- All file paths go through `normalizePath()` before being used.

## Not yet tested

I can't test the plugin inside a live Obsidian instance from here. Before submitting, actually try it on Windows/macOS/Linux/iOS/Android as applicable — the PR checklist asks you to confirm which platforms you tested on.
