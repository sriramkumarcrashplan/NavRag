console.log('content script loaded');
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ask-user") {
    // Forward this to side-panel UI
    chrome.runtime.sendMessage(msg);
  }
});