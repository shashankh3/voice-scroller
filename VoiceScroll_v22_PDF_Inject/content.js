(function () {
  'use strict';
  if (window.__vs) return;

  let rec = null;
  let active = false;
  let sleeping = false;
  let lastCmdTime = 0;
  let subEl = null;
  let subTimer = null;
  let matchers = {};
  
  const IS_PDF = document.contentType === 'application/pdf' || window.location.pathname.toLowerCase().endsWith('.pdf');
  const IS_FILE = window.location.protocol === 'file:';

  let cfg = {
    dist: 300, smooth: true,
    cDn: 'down, done', cUp: 'back, lift',
    cPd: 'page down, next', cPu: 'reverse, return',
    cTop: 'top', cBot: 'bottom',
    cSleep: 'sleep, pause', cWake: 'wake up, awake'
  };

  /* ── LIVE SETTINGS UPDATE ── */
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') {
        let needsRebuild = false;
        for (let key in changes) {
          if (cfg.hasOwnProperty(key)) {
            cfg[key] = changes[key].newValue;
            if (key !== 'dist' && key !== 'smooth') needsRebuild = true;
          }
        }
        if (needsRebuild) buildMatchers();
        if (active) showUI('⚙️ Updated', 'std');
      }
    });
  } catch(e) {}

  /* ── PDF MODE (FIXED) ── */
  function initPDFMode() {
    if (!IS_PDF || document.getElementById('__vsPdfWrapper')) return;

    const wrapper = document.createElement('div');
    wrapper.id = '__vsPdfWrapper';
    Object.assign(wrapper.style, {
      position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
      background: '#525659', zIndex: '2147483640', overflowY: 'auto', overflowX: 'hidden'
    });

    const embed = document.createElement('embed');
    embed.src = window.location.href + '#toolbar=0&navpanes=0&scrollbar=0';
    embed.type = 'application/pdf';
    
    // CRITICAL FIX: We force the embed to be massive (5000vh) so the WRAPPER has something to scroll.
    // However, we removed the scroll multiplier logic below so it moves normally.
    Object.assign(embed.style, {
      width: '100%', 
      height: '5000vh',  // This restores the scrollbar
      border: 'none', 
      display: 'block' 
    });

    wrapper.appendChild(embed);
    document.body.appendChild(wrapper);
    document.body.style.overflow = 'hidden';
    
    document.querySelectorAll('embed[type="application/pdf"]').forEach(e => {
        if(e !== embed) e.style.display = 'none';
    });
  }

  /* ── SCROLL LOGIC ── */
  function getTarget() {
    const pdf = document.getElementById('__vsPdfWrapper');
    if (pdf) return pdf;

    if (document.scrollingElement && document.scrollingElement.scrollHeight > window.innerHeight) {
        return document.scrollingElement;
    }
    return document.body;
  }

  function doScroll(cmd) {
    const el = getTarget();
    const isWindow = (el === document.scrollingElement || el === document.body || el === document.documentElement);
    
    const behavior = cfg.smooth ? 'smooth' : 'instant';
    const dist = parseInt(cfg.dist) || 300;
    const viewHeight = window.innerHeight;

    if (cmd === 'top') {
        isWindow ? window.scrollTo({ top: 0, behavior }) : el.scrollTo({ top: 0, behavior });
    } 
    else if (cmd === 'bot') {
        const limit = el.scrollHeight;
        isWindow ? window.scrollTo({ top: limit, behavior }) : el.scrollTo({ top: limit, behavior });
    } 
    else {
        let amount = dist;
        
        // If it's the PDF Wrapper, we slightly boost the scroll because 5000vh is very tall,
        // but not by 3x like before. 1.2x feels natural for PDFs.
        if (el.id === '__vsPdfWrapper') amount = amount * 1.2;

        if (cmd === 'pd' || cmd === 'pu') amount = viewHeight * 0.9; 

        const delta = (cmd === 'dn' || cmd === 'pd') ? amount : -amount;
        
        isWindow ? window.scrollBy({ top: delta, behavior }) : el.scrollBy({ top: delta, behavior });
    }
  }

  /* ── COMMAND PARSING ── */
  function buildMatchers() {
    const create = (str) => {
        if (!str) return null;
        const parts = str.split(',').map(s => s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
        return parts.length ? new RegExp('\\b(' + parts.join('|') + ')\\b', 'i') : null;
    };

    matchers = {
        sleep: create(cfg.cSleep),
        wake: create(cfg.cWake),
        dn: create(cfg.cDn),
        up: create(cfg.cUp),
        pd: create(cfg.cPd),
        pu: create(cfg.cPu),
        top: create(cfg.cTop),
        bot: create(cfg.cBot)
    };
  }

  /* ── SPEECH ENGINE ── */
  function start() {
    if (active) return;
    
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { showUI('❌ No Speech API', 'err'); return; }

    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';

    rec.onstart = () => {
        active = true;
        showUI('Listening...', 'std');
    };

    rec.onresult = (e) => {
        const result = e.results[e.results.length - 1];
        if (!result) return;
        
        const transcript = result[0].transcript.toLowerCase().trim();
        
        if (sleeping) showUI('💤 ' + transcript, 'sleep');
        else showUI(transcript, 'std');

        const now = Date.now();
        if (now - lastCmdTime < 250) return; 

        let cmd = null;
        
        if (sleeping) {
            if (matchers.wake && matchers.wake.test(transcript)) {
                sleeping = false;
                showUI('🟢 Awake', 'success');
                lastCmdTime = now;
                resetRec();
            }
            return;
        } 
        
        if (matchers.sleep && matchers.sleep.test(transcript)) {
            sleeping = true;
            showUI('💤 Sleeping...', 'sleep');
            lastCmdTime = now;
            return;
        }

        if (matchers.dn && matchers.dn.test(transcript)) cmd = 'dn';
        else if (matchers.up && matchers.up.test(transcript)) cmd = 'up';
        else if (matchers.pd && matchers.pd.test(transcript)) cmd = 'pd';
        else if (matchers.pu && matchers.pu.test(transcript)) cmd = 'pu';
        else if (matchers.top && matchers.top.test(transcript)) cmd = 'top';
        else if (matchers.bot && matchers.bot.test(transcript)) cmd = 'bot';

        if (cmd) {
            doScroll(cmd);
            lastCmdTime = now;
            const labels = { dn:'⬇', up:'⬆', pd:'⏬ PgDn', pu:'⏫ PgUp', top:'T Top', bot:'_ Bot' };
            showUI(labels[cmd], 'success');
            if (!IS_FILE) resetRec(); 
        }
    };

    rec.onerror = (e) => {
        if (e.error === 'not-allowed') {
            active = false;
            showUI('❌ Mic Blocked', 'err');
        }
    };

    rec.onend = () => { if (active) rec.start(); };

    try { rec.start(); } catch(e){ active=false; }
  }

  function resetRec() {
      if (rec && active) rec.abort();
  }

  function showUI(text, type) {
    if (!subEl) {
        subEl = document.createElement('div');
        subEl.id = '__vsSub';
        Object.assign(subEl.style, {
            position:'fixed', bottom:'30px', left:'50%', transform:'translateX(-50%)',
            padding:'8px 20px', borderRadius:'30px', fontSize:'14px', fontWeight:'600',
            backdropFilter:'blur(5px)', zIndex:'2147483647', pointerEvents:'none',
            transition:'opacity 0.2s', fontFamily:'sans-serif', textAlign:'center',
            boxShadow:'0 4px 12px rgba(0,0,0,0.3)'
        });
        document.body.appendChild(subEl);
    }

    if (type === 'err') subEl.style.background = 'rgba(220, 38, 38, 0.9)';
    else if (type === 'success') subEl.style.background = 'rgba(22, 163, 74, 0.9)';
    else if (type === 'sleep') subEl.style.background = 'rgba(234, 88, 12, 0.9)';
    else subEl.style.background = 'rgba(30, 30, 30, 0.85)';
    
    subEl.style.color = '#fff';
    subEl.textContent = text;
    subEl.style.opacity = '1';

    clearTimeout(subTimer);
    subTimer = setTimeout(() => {
        if (active) {
            subEl.style.background = 'rgba(30, 30, 30, 0.85)';
            subEl.textContent = sleeping ? '💤' : '🎤';
        } else {
            subEl.style.opacity = '0';
        }
    }, 1500);
  }

  window.__vs = {
    toggle: async () => {
        if (active) {
            active = false;
            if (rec) rec.abort();
            showUI('Stopped', 'std');
            setTimeout(() => { if(subEl) subEl.style.opacity = '0'; }, 500);
            
            const pdf = document.getElementById('__vsPdfWrapper');
            if (pdf) {
                pdf.remove();
                document.body.style.overflow = '';
                document.querySelectorAll('embed[type="application/pdf"]').forEach(e => e.style.display = '');
            }
            return false;
        } else {
            try {
                const items = await chrome.storage.sync.get(cfg);
                Object.assign(cfg, items);
                buildMatchers();
            } catch(e){}
            if (IS_PDF) initPDFMode();
            start();
            return true;
        }
    },
    status: () => active
  };
})();