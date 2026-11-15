// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// Right-click menu: send selected text or an image from any page into the current note.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "add-text", title: "Add selection to Note Sidekick", contexts: ["selection"] });
  chrome.contextMenus.create({ id: "add-image", title: "Add image to Note Sidekick", contexts: ["image"] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Opening must happen synchronously inside the user gesture.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  const item =
    info.menuItemId === "add-text"
      ? { type: "text", text: info.selectionText, source: tab.url }
      : { type: "image", src: info.srcUrl, source: tab.url };
  // Queue it; the panel picks it up on load or via storage change.
  const { inbox = [] } = await chrome.storage.local.get("inbox");
  inbox.push(item);
  await chrome.storage.local.set({ inbox });
});
