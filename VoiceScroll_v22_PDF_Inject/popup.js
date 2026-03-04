const DEFAULTS = {
  dist: 300, smooth: true,
  cDn: 'down, done', cUp: 'back, lift',
  cPd: 'page down, next', cPu: 'reverse, return',
  cSleep: 'sleep, pause', cWake: 'wake up, awake'
};

const els = {
  btn: document.getElementById('btn'), 
  bt: document.getElementById('bt'), 
  pill: document.getElementById('pill'),
  dist: document.getElementById('cDist'), 
  dVal: document.getElementById('dVal'), 
  smooth: document.getElementById('cSmooth'),
  inputs: [
    document.getElementById('cDn'), document.getElementById('cUp'), 
    document.getElementById('cPd'), document.getElementById('cPu'), 
    document.getElementById('cSleep'), document.getElementById('cWake')
  ]
};

// 1. Load Settings
chrome.storage.sync.get(DEFAULTS, (cfg) => {
  els.dist.value = cfg.dist; 
  els.dVal.textContent = cfg.dist + 'px';
  els.smooth.checked = cfg.smooth;
  
  const keys = ['cDn', 'cUp', 'cPd', 'cPu', 'cSleep', 'cWake'];
  els.inputs.forEach((input, i) => {
    input.value = cfg[keys[i]];
    input.dataset.key = keys[i];
  });
});

// 2. Save Settings (Instant)
function save() {
  const data = {
    dist: parseInt(els.dist.value), 
    smooth: els.smooth.checked
  };
  els.inputs.forEach(input => {
    data[input.dataset.key] = input.value;
  });
  chrome.storage.sync.set(data);
}

els.dist.oninput = () => { els.dVal.textContent = els.dist.value + 'px'; save(); };
els.smooth.onchange = save;
els.inputs.forEach(el => el.oninput = save);

// 3. Toggle Logic
els.btn.onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  
  try {
    // Ensure content script is loaded
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    
    // Toggle
    const res = await chrome.scripting.executeScript({ 
      target: { tabId: tab.id }, 
      func: async () => { return await window.__vs.toggle(); }
    });
    
    updateUI(res[0].result === true);
  } catch(e) { 
    els.pill.textContent = "Error: Refresh Page";
    els.pill.style.color = "red";
  }
};

// 4. UI Update
function updateUI(active) {
  if (active) {
    els.btn.className = 'on';
    els.bt.textContent = 'Stop Listening';
    els.pill.textContent = '● Active';
    els.pill.style.color = '#4ade80';
  } else {
    els.btn.className = '';
    els.bt.textContent = 'Start Listening';
    els.pill.textContent = '● Inactive';
    els.pill.style.color = '#888';
  }
}

// Initial Check
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__vs?.status() });
      updateUI(res[0].result === true);
    } catch(e) { updateUI(false); }
  }
})();