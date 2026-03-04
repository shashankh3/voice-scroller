
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'toggle-voice-scroll') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__vs?.toggle() });
    }
  }
});
