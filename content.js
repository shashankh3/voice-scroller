
(function () {
  'use strict';
  if (window.__vs) return;

  let rec    = null;
  let on     = false;
  let lastAt = 0;
  const IS_FILE = location.protocol === 'file:';

  window.__vs = { toggle: () => on ? stop() : start(), status: () => on, start, stop };

  /* ════════════════════════════════════════════════════════════════════════
     COMMAND PARSER — Final Bluetooth-Optimized
  ══════════════════════════════════════════════════════════════════════════ */
  function parse(t) {
    // Large Up
    if (/\b(page\s*up|prev\w*\s*page|page\s*back|pay\s*jump|bake\s*up|paypal|reverse|return|backward)\b/.test(t)) return 'pu';
    // Large Down
    if (/\b(page\s*down|next\s*page|page\s*next|next|forward)\b/.test(t)) return 'pd';
    // Extremes
    if (/\b(top|go\s*to\s*top|beginning|first\s*page)\b/.test(t)) return 'top';
    if (/\b(bottom|end|go\s*to\s*bottom|last\s*page)\b/.test(t))  return 'bot';
    // Small Up ("back" is the primary reliable command)
    if (/\b(scroll\s*up|go\s*up|move\s*up|up|app|off|hop|cup|ascend|lift|raise|back|high)\b/.test(t)) return 'up';
    // Small Down
    if (/\b(scroll\s*down|go\s*down|move\s*down|down|done|town|drop|fall|low)\b/.test(t)) return 'dn';
    return null;
  }

  function tgt() {
    const host = document.querySelector('pdf-viewer');
    if (host?.shadowRoot) {
      const s = host.shadowRoot.getElementById('scroller'); if (s) return s;
    }
    const pj = document.getElementById('viewer') || document.querySelector('.pdfViewer');
    if (pj) return pj;
    const dse = document.scrollingElement;
    if (dse && dse.scrollHeight > dse.clientHeight + 20) return dse;
    let n = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (/scroll|auto/.test(cs.overflow + cs.overflowY) && n.scrollHeight > n.clientHeight + 20) return n;
      n = n.parentElement;
    }
    let best = null, bestH = 0;
    document.querySelectorAll('*').forEach(el => {
      if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > innerHeight * 0.4) {
        const cs = getComputedStyle(el);
        if (/scroll|auto/.test(cs.overflow + cs.overflowY) && el.scrollHeight > bestH) { best = el; bestH = el.scrollHeight; }
      }
    });
    return best;
  }

  function doScroll(cmd) {
    const el = tgt(), H = el ? el.clientHeight : innerHeight;
    if      (cmd === 'top') { el ? (el.scrollTop = 0)               : scrollTo(0,0); }
    else if (cmd === 'bot') { el ? (el.scrollTop = el.scrollHeight) : scrollTo(0, document.body.scrollHeight); }
    else {
      const big = cmd === 'pd' || cmd === 'pu';
      const dy  = (cmd === 'dn' || cmd === 'pd') ? (big ? H*.88 : 280) : -(big ? H*.88 : 280);
      el ? (el.scrollTop += dy) : scrollBy(0, dy);
    }
  }

  function start() {
    if (on) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { flash('❌ SpeechRecognition unavailable'); return; }

    rec = new SR();
    rec.continuous      = true;
    rec.interimResults  = true;
    rec.lang            = 'en-US';
    rec.maxAlternatives = 5;

    rec.onstart = () => { dot(true); flash('🎤 ON'); };

    rec.onresult = (e) => {
      const now = Date.now();
      if (now - lastAt < 100) return;

      outer: for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        for (let a = 0; a < res.length; a++) {
          const raw = res[a].transcript.toLowerCase();
          const cmd = parse(raw);
          if (cmd) {
            doScroll(cmd);
            // Show the actual action performed, regardless of the word spoken
            flash({ dn:'⬇ Down', up:'⬆ Up', pd:'⬇ Page Down', pu:'⬆ Page Up', top:'⬆ Top', bot:'⬇ Bottom' }[cmd]);
            lastAt = now;
            try { rec?.abort(); } catch(_){}
            break outer;
          }
        }
      }
    };

    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        on = false; dot(false);
        if (IS_FILE) { flash('❌ Allow mic for file:// — see tip'); showFileTip(); }
        else { flash('❌ Mic blocked — allow in address bar'); }
      }
    };

    rec.onend = () => {
      if (on && rec) setTimeout(() => {
        if (on && rec) try { rec.start(); } catch(_) {}
      }, 10);
    };

    on = true;
    try { rec.start(); }
    catch (e) { flash('❌ ' + e.message); on = false; }
  }

  function stop() {
    on = false;
    try { rec?.abort(); } catch(_) {}
    rec = null; dot(false); flash('🔇 OFF');
  }

  function showFileTip() {
    if (document.getElementById('__vsTip')) return;
    const d = document.createElement('div'); d.id = '__vsTip';
    d.innerHTML = '<b style="color:#f87">Fix for local PDFs:</b><br>'
      + '1. Open <b>edge://settings/content/microphone</b><br>'
      + '2. Under "Allow", click <b>Add</b><br>'
      + '3. Type <b>file://</b> and add it.<br>'
      + '<span id="__vsTX" style="position:absolute;top:7px;right:9px;cursor:pointer">✕</span>';
    Object.assign(d.style, {
      position:'fixed', bottom:'68px', right:'16px', maxWidth:'268px',
      background:'#111', color:'#ccc', padding:'11px 13px', borderRadius:'9px',
      fontSize:'11px', lineHeight:'1.7', zIndex:'2147483647',
      border:'1px solid #333', boxShadow:'0 4px 20px rgba(0,0,0,.7)'
    });
    (document.body||document.documentElement).appendChild(d);
    document.getElementById('__vsTX').onclick = () => d.remove();
  }

  let $d, $f, $ft;
  function mkEl(id, css, txt) {
    const e = Object.assign(document.createElement('div'),{id,textContent:txt||''});
    Object.assign(e.style,css); (document.body||document.documentElement).appendChild(e); return e;
  }
  function dot(a) {
    if (!$d||!document.getElementById('__vsd'))
      $d=mkEl('__vsd',{position:'fixed',top:'14px',right:'14px',width:'32px',height:'32px',
        borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',
        fontSize:'15px',zIndex:'2147483647',pointerEvents:'none',
        transition:'background .2s,box-shadow .2s',backdropFilter:'blur(6px)'},'🎤');
    $d.style.background=a?'rgba(34,197,94,.92)':'rgba(22,22,22,.86)';
    $d.style.boxShadow =a?'0 0 14px rgba(34,197,94,.7)':'0 2px 8px rgba(0,0,0,.5)';
  }
  function flash(msg) {
    if (!$f||!document.getElementById('__vsf'))
      $f=mkEl('__vsf',{position:'fixed',bottom:'16px',right:'16px',
        background:'rgba(0,0,0,.9)',color:'#fff',padding:'6px 14px',
        borderRadius:'999px',fontSize:'12px',fontFamily:'system-ui,sans-serif',
        fontWeight:'700',zIndex:'2147483647',pointerEvents:'none',opacity:'0',
        transition:'opacity .08s',backdropFilter:'blur(8px)'});
    $f.textContent=msg; $f.style.opacity='1';
    clearTimeout($ft); $ft=setTimeout(()=>{$f.style.opacity='0';},1200);
  }
  dot(false);
})();
