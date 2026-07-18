# Publishing checklist

Everything file-level is done: `manifest.json`, `main.js`, `styles.css`, `README.md`, `LICENSE`, `versions.json`, and a release workflow at `.github/workflows/release.yml` that automates step 2 below. What's left are actions on GitHub itself, which only you can do (they require your account).

## If you've already submitted 1.0.0 to obsidian-releases

**Releasing a new version (like 1.1.0) does not need a new pull request.** Once a plugin is listed in `community-plugins.json`, Obsidian's in-app updater checks your repo's releases for a newer version than what's installed and offers the update automatically — it re-reads `manifest.json` from your latest release each time. You only need to redo the fork/PR/`community-plugins.json` step if the plugin's `id`, `name`, or `repo` location changes. For a routine version bump, just do step 2 below (tag + release) and you're done.

## Steps

1. **Create a public GitHub repository** and push these files to its root (not a subfolder) — `main.js`, `manifest.json`, `styles.css`, `README.md`, `LICENSE`, `versions.json`, `.github/workflows/release.yml`. (Skip this if the repo already exists — just push the updated files to `main`.)

2. **Tag a release matching `manifest.json`'s version:**
   ```
   git tag 1.1.0
   git push origin 1.1.0
   ```
   With the workflow in place, this alone creates the GitHub Release with the three required files attached as individual assets. (If you'd rather not use the workflow, you can instead go to GitHub → Releases → "Draft a new release," use `1.1.0` as the tag with no `v` prefix, and manually attach `main.js`, `manifest.json`, and `styles.css` as binary attachments.)

3. **Only for the very first submission** — fork [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) and add an entry to the end of `community-plugins.json`:
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

4. **Only for the very first submission** — open a pull request to `obsidianmd/obsidian-releases`. GitHub will load a PR template with a checklist — check off each item honestly (tested platforms, README completeness, developer policies read, license present, etc.). An automated bot validates the submission within a few minutes and comments with any issues to fix.

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
