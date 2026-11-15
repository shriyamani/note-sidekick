# Snap Notes Sidebar

A Chrome side-panel notes extension with images, unlimited notes and a list of all notes.

## Install (2 minutes)
1. Unzip this folder somewhere permanent (Chrome loads it from that location).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `notes-panel` folder.
4. Pin the extension and click its icon, or press **Ctrl+Shift+Y** (Cmd+Shift+Y on Mac).

## Features
- **Images:** paste screenshots or copied images (Ctrl/Cmd+V), drag and drop image files, or use the 🖼 button. Large images are shrunk automatically to save space.
- **Select several images:** click one, then Ctrl/Cmd+click or Shift+click more, or drag a selection across them. Ctrl/Cmd+A (with an image selected) selects every image in the note.
- **Copy with Ctrl/Cmd+C** (Ctrl/Cmd+X cuts). Apps that take rich content (Google Docs, Gmail, Notion, Word, Snap Notes) get each image separately. Apps that take only one image (Slack, Discord, image editors) get them stacked into one picture.
- The bar at the bottom also has Copy, Save (download), Delete, All, and ✕ (clear). Esc clears the selection.
- Double-click an image to view it full size.
- **Unlimited notes:** **+ New** or **Alt+N**. Notes save automatically.
- **All-notes list:** search, pin (★) notes to the top, and see thumbnails and image counts.
- Formatting: bold, italic, underline, bullet and numbered lists, checklists (click the box to tick).
- **Right-click on any page:** "Add selection to Snap Notes" or "Add image to Snap Notes".
- **Export / Import** all notes as JSON for backup.
- Esc goes back to the list. Light and dark mode follow your system setting.

## Where data lives
Notes are stored locally in Chrome (`chrome.storage.local` with `unlimitedStorage`). Nothing leaves your machine.
Removing the extension deletes the notes, so export a backup first.

## Files
- `manifest.json`: extension config (Manifest V3, side panel)
- `background.js`: opens the panel and handles the right-click menu
- `sidepanel.html/.css/.js`: the notes UI
