
'use strict';
const btn  = document.getElementById('btn');
const bt   = document.getElementById('bt');
const pill = document.getElementById('pill');

function ui(on) {
  btn.classList.toggle('on', !!on);
  bt.textContent   = on ? 'Disable VoiceScroll' : 'Enable VoiceScroll';
  pill.textContent = on ? '● Listening…' : '● Inactive';
  pill.classList.toggle('on', !!on);
}

// Query current state on open
chrome.runtime.sendMessage({ action: 'status' }, r => {
  if (chrome.runtime.lastError) return;
  ui(r?.on);
});

btn.addEventListener('click', () => {
  btn.disabled = true;
  chrome.runtime.sendMessage({ action: 'toggle' }, r => {
    btn.disabled = false;
    if (chrome.runtime.lastError) { console.error(chrome.runtime.lastError); return; }
    ui(r?.on);
  });
});
