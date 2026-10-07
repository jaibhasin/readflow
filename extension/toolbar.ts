export async function showWalkman(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "show_readflow" });
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["highlight.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  }
}

chrome.action.onClicked.addListener((tab) => {
  void showWalkman(tab).then(async () => {
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    await chrome.action.setTitle({ tabId: tab.id, title: "Show Readflow Walkman" });
  }).catch(async () => {
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    await chrome.action.setTitle({ tabId: tab.id, title: "Readflow cannot open here. Try a regular website tab." });
  });
});
