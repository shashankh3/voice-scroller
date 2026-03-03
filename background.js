
'use strict';

/* Ensure content script is injected, then execute fn in MAIN world */
async function mx(tabId, fn) {
  try {
    await chrome.scripting.executeScript({ target:{tabId}, files:['content.js'], world:'MAIN' });
  } catch (_) {}
  const r = await chrome.scripting.executeScript({ target:{tabId}, world:'MAIN', func: fn });
  return r?.[0]?.result ?? null;
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  (async () => {
    const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
    if (!tab?.id) { reply({ on: false }); return; }

    if (msg.action === 'status') {
      reply({ on: await mx(tab.id, () => window.__vs?.status() ?? false) });

    } else if (msg.action === 'toggle') {
      await mx(tab.id, () => window.__vs?.toggle());
      reply({ on: await mx(tab.id, () => window.__vs?.status() ?? false) });
    }
  })();
  return true;
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-voice-scroll') return;
  const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
  if (!tab?.id) return;
  await mx(tab.id, () => window.__vs?.toggle());
});
