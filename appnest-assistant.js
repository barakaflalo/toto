/* ═══════════════════════════════════════════════════════════════════════
   AppNest Assistant — המנוע הקבוע (זהה בכל האפליקציות)
   ─────────────────────────────────────────────────────────────────────
   צ'אטבוט היברידי: מדבר בשפה טבעית, עונה על שאלות, ויכול לבצע פעולות
   באפליקציה (לכתוב לשדה, לנווט בין מסכים, להדגיש כפתור).

   איך זה בנוי:
   • המנוע (הקובץ הזה) — לא משתנה בין אפליקציות. מעתיקים אותו כמו שהוא.
   • ה"מפה" — window.APPNEST_ASSISTANT_CONFIG, מוגדרת בכל אפליקציה בנפרד,
     ומתארת למנוע את המסכים/השדות/הכפתורים והרקע של אותה אפליקציה.

   ה-AI: משתמש ב-BYOK הקיים (המפתח שהמשתמש כבר חיבר). נקרא בשפת-האם של כל
   ספק (Claude / Gemini / OpenAI / מקומי / מותאם) — בלי שכבות תרגום.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var CFG = window.APPNEST_ASSISTANT_CONFIG;
  if (!CFG) { console.warn('[AppNest Assistant] אין הגדרות (APPNEST_ASSISTANT_CONFIG) — המנוע לא הופעל.'); return; }

  /* ─────────────── 1. קריאת ה-AI לפי הספק שהמשתמש חיבר ─────────────── */
  // קורא את הגדרות ה-BYOK של האפליקציה. שם המפתח ב-localStorage ניתן להתאמה
  // דרך המפה (CFG.aiConfigKey); ברירת מחדל מתאימה ל-SunoPrep/AppNest.
  function readAiConfig() {
    // אם האפליקציה מגדירה קריאת config משלה (כי היא שומרת מפתחות אחרת) — נשתמש בה.
    if (typeof CFG.readAiConfig === 'function') { try { return CFG.readAiConfig(); } catch (e) { return null; } }
    var storeKey = CFG.aiConfigKey || 'sp_ai-config';
    try {
      var raw = localStorage.getItem(storeKey);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function clean(s) { return (s || '').replace(/[\r\n\t]/g, '').trim(); }
  // מפצל שדה מפתחות (שיכול להכיל כמה מפתחות מופרדים בפסיק/שורה) ומחזיר את הראשון הנקי,
  // בדיוק כמו שהאפליקציה עצמה עושה. מונע מצב של פסיקים/רווחים נסתרים שמשבשים את המפתח.
  function firstKey(s) {
    var arr = (s || '').split(/[\n,;]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    return arr[0] || '';
  }

  // מריץ prompt מול הספק המחובר, מחזיר טקסט. זורק אם אין מפתח/ספק.
  async function callAI(prompt) {
    var cfg = readAiConfig();
    if (!cfg || !cfg.provider) throw new Error('NO_AI');
    var p = cfg.provider, k = cfg.keys || {};

    if (p === 'gemini') {
      // מתחיל תמיד מהמודל העדכני (alias שמצביע על הכי חדש), עם גיבויים עדכניים.
      // לא נשען על מודל שמור — כדי לא להיתקע על גרסה שכבר לא קיימת.
      var models = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.0-flash'];
      var key = firstKey(k.gemini), lastErr = null;
      for (var i = 0; i < models.length; i++) {
        var genCfg = { temperature: 0.5, maxOutputTokens: 4000 };
        if (models[i].indexOf('gemini-2.5') === 0 || models[i].indexOf('gemini-3') === 0) genCfg.thinkingConfig = { thinkingBudget: 0 };
        try {
          var r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent?key=' + encodeURIComponent(key), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: genCfg })
          });
          if (r.ok) {
            var d = await r.json();
            return (d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts[0] && d.candidates[0].content.parts[0].text) || '';
          }
          var ej = await r.json().catch(function () { return {}; });
          lastErr = new Error((ej && ej.error && ej.error.message) || ('HTTP ' + r.status));
          if ([404, 429, 500, 503].indexOf(r.status) === -1) throw lastErr;
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('Gemini unavailable');
    }

    if (p === 'claude') {
      var res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': firstKey(k.claude),
          'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] })
      });
      if (!res.ok) { var ec = await res.json().catch(function () { return {}; }); throw new Error((ec.error && ec.error.message) || ('HTTP ' + res.status)); }
      var dc = await res.json();
      return (dc.content && dc.content[0] && dc.content[0].text) || '';
    }

    // openai / device / custom — כולם פורמט OpenAI
    var url, okey, model;
    if (p === 'openai') { url = 'https://api.openai.com/v1/chat/completions'; okey = firstKey(k.openai); model = 'gpt-4o-mini'; }
    else if (p === 'device') { url = (k.deviceUrl || '').replace(/\/+$/, '') + '/chat/completions'; okey = ''; model = 'llama3'; }
    else if (p === 'custom') { url = k.customUrl || ''; okey = firstKey(k.customKey); model = 'gpt-4o-mini'; }
    else throw new Error('UNKNOWN_PROVIDER');
    var h = { 'Content-Type': 'application/json' };
    if (okey) h['Authorization'] = 'Bearer ' + okey;
    var ro = await fetch(url, { method: 'POST', headers: h,
      body: JSON.stringify({ model: model, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }) });
    if (!ro.ok) { var eo = await ro.json().catch(function () { return {}; }); throw new Error((eo.error && eo.error.message) || ('HTTP ' + ro.status)); }
    var do_ = await ro.json();
    return (do_.choices && do_.choices[0] && do_.choices[0].message && do_.choices[0].message.content) || '';
  }

  /* ─────────────── 2. פעולות על האפליקציה (מבוססות המפה) ─────────────── */
  // מציאת אלמנט לפי טקסט גלוי (יציב יותר מ-selectors באפליקציית React)
  function findByText(tag, text) {
    var els = document.querySelectorAll(tag);
    text = text.trim();
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').trim();
      if (t === text || t.indexOf(text) !== -1) return els[i];
    }
    return null;
  }
  function findField(spec) {
    if (spec.placeholder) {
      var els = document.querySelectorAll('textarea, input');
      for (var i = 0; i < els.length; i++) {
        var ph = els[i].getAttribute('placeholder') || '';
        if (ph.indexOf(spec.placeholder) !== -1) return els[i];
      }
    }
    if (spec.selector) return document.querySelector(spec.selector);
    return null;
  }
  // כתיבה לשדה בצורה ש-React "רואה" (native setter + אירוע input)
  function setReactValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function flash(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var old = el.style.boxShadow, oldT = el.style.transition;
    el.style.transition = 'box-shadow .3s';
    el.style.boxShadow = '0 0 0 3px #C9A84C, 0 0 18px #C9A84C';
    setTimeout(function () { el.style.boxShadow = old; el.style.transition = oldT; }, 2200);
  }

  // מבצע פעולה שה-AI ביקש. מחזיר טקסט-משוב קצר (או null אם נכשל).
  function runAction(act) {
    try {
      if (act.action === 'navigate') {
        var tab = (CFG.tabs || []).filter(function (t) { return t.name === act.target; })[0];
        // אם האפליקציה מגדירה פונקציית ניווט משלה (למשל showScreen) — נשתמש בה.
        if (typeof CFG.navigate === 'function') {
          if (!tab) return null;
          CFG.navigate(tab.screen || tab.match || act.target);
          return 'עברתי למסך "' + act.target + '".';
        }
        // ברירת מחדל: מציאת כפתור לפי טקסט ולחיצה
        var btn = findByText('button', (tab && tab.match) || act.target);
        if (btn) { btn.click(); return 'עברתי למסך "' + act.target + '".'; }
        return null;
      }
      if (act.action === 'writeField') {
        var fld = (CFG.fields || []).filter(function (f) { return f.name === act.target; })[0];
        var el = fld && findField(fld);
        if (el) { setReactValue(el, act.text || ''); flash(el); return 'כתבתי ל' + (fld.label || 'שדה') + '.'; }
        return null;
      }
      if (act.action === 'highlight') {
        var target = act.target;
        var el2 = findByText('button', target) || (CFG.fields || []).filter(function (f) { return f.name === target; }).map(function (f) { return findField(f); })[0];
        if (el2) { flash(el2); return 'הנה זה — סימנתי לך בזהב.'; }
        return null;
      }
      if (act.action === 'appAction') {
        // פעולה ייחודית לאפליקציה — מוגדרת במפה (CFG.actions), מפעילה פונקציה של האפליקציה.
        var custom = (CFG.actions || {})[act.target];
        if (custom && typeof custom.run === 'function') {
          try { custom.run(); return custom.done || 'בוצע ✓'; } catch (e) { return null; }
        }
        return null;
      }
    } catch (e) { return null; }
    return null;
  }

  /* ─────────────── 3. הנחיית ה-AI (system prompt מהמפה) ─────────────── */
  function buildPrompt(history, userMsg) {
    var tabNames = (CFG.tabs || []).map(function (t) { return '"' + t.name + '"'; }).join(', ');
    var fieldList = (CFG.fields || []).map(function (f) { return '"' + f.name + '" (' + (f.label || '') + ')'; }).join(', ');
    var convo = history.slice(-12).map(function (m) { return (m.role === 'user' ? 'משתמש' : 'עוזר') + ': ' + m.text; }).join('\n');

    // "עיניים" — קורא את התוכן הנוכחי של השדות, כדי שהעוזר יוכל להתייחס אליו
    // (לשפר, לתרגם, לענות על "מה כתבתי") בלי לבקש מהמשתמש להדביק.
    var fieldState = (CFG.fields || []).map(function (f) {
      var el = findField(f);
      var val = el ? (el.value || '') : '';
      if (val.length > 1500) val = val.slice(0, 1500) + '…';
      return '• ' + (f.label || f.name) + ': ' + (val ? '"' + val + '"' : '(ריק)');
    }).join('\n');

    // מצב כללי של האפליקציה (אם האפליקציה מספקת תיאור מצב משלה)
    var appState = '';
    if (typeof CFG.readState === 'function') { try { appState = CFG.readState() || ''; } catch (e) {} }

    // פעולות ייחודיות לאפליקציה (מעבר לניווט/כתיבה/הדגשה)
    var customActions = CFG.actions || {};
    var actionList = Object.keys(customActions).map(function (k) { return '"' + k + '" — ' + (customActions[k].desc || ''); }).join('\n');

    return [
      'אתה עוזר חכם בתוך האפליקציה "' + CFG.appName + '".',
      CFG.appDescription || '',
      '',
      'אתה יכול גם לבצע פעולות באפליקציה. כשמתאים, החזר בלוק פעולה בשורה נפרדת בסוף התשובה,',
      'בפורמט הזה בדיוק (JSON בין הסימנים):',
      '<<ACTION>>{"action":"navigate","target":"שם המסך"}<<END>>',
      '<<ACTION>>{"action":"writeField","target":"שם השדה","text":"התוכן המלא"}<<END>>',
      '<<ACTION>>{"action":"highlight","target":"טקסט הכפתור או שם השדה"}<<END>>',
      (actionList ? '<<ACTION>>{"action":"appAction","target":"שם הפעולה"}<<END>>' : ''),
      'אם המשתמש ביקש כמה דברים ברצף (למשל "כתוב שיר ואז עבור לקולות") — החזר כמה בלוקי פעולה, כל אחד בשורה נפרדת, בסדר שבו הם צריכים להתבצע (בדרך כלל: קודם לכתוב לשדה, ורק אחר כך לנווט למסך אחר).',
      '',
      'מסכים זמינים לניווט: ' + (tabNames || '(אין)'),
      'שדות זמינים לכתיבה: ' + (fieldList || '(אין)'),
      (actionList ? 'פעולות ייחודיות זמינות (appAction):\n' + actionList : ''),
      '',
      'התוכן שנמצא כרגע בשדות האפליקציה (כדי שתוכל להתייחס אליו — לשפר, לתרגם, לענות עליו):',
      (fieldState || '(אין שדות)'),
      (appState ? '\nמצב האפליקציה כרגע:\n' + appState : ''),
      '',
      'כללים: דבר בעברית, טבעי וידידותי. תמיד כתוב קודם תשובה קצרה למשתמש, ורק אחריה (אם צריך) את בלוק הפעולה.',
      'אם המשתמש מבקש ליצור או לשנות תוכן (שיר, טקסט) — כתוב את התוצאה המלאה בתוך writeField, לא בגוף הצ\'אט.',
      'אם המשתמש מבקש לשפר/לשנות/לתרגם משהו "שכתבתי" — התבסס על התוכן הנוכחי של השדות למעלה.',
      'לניווט (navigate): השתמש אך ורק בשם מסך שמופיע בדיוק ברשימת המסכים למעלה. אם המשתמש מבקש מסך שלא ברשימה — אל תנחש ואל תנווט למסך אחר; במקום זה אמור לו בקצרה שאין מסך כזה, או שאל למה התכוון.',
      'אם זו רק שאלה/שיחה — אל תחזיר בלוק פעולה בכלל.',
      '',
      (convo ? 'שיחה עד כה:\n' + convo + '\n' : ''),
      'משתמש: ' + userMsg,
      'עוזר:'
    ].join('\n');
  }

  function parseReply(raw) {
    var actions = [], text = raw;
    var re = /<<ACTION>>([\s\S]*?)<<END>>/g, m;
    while ((m = re.exec(raw)) !== null) {
      try { actions.push(JSON.parse(m[1].trim())); } catch (e) {}
    }
    text = raw.replace(/<<ACTION>>[\s\S]*?<<END>>/g, '').trim();
    return { text: text, actions: actions };
  }

  /* ─────────────── 4. ממשק המשתמש (חלון צ'אט + כפתור) ─────────────── */
  // זיכרון מתמשך — השיחה נשמרת מקומית (localStorage) ונטענת בביקור הבא.
  // מפתח ייחודי לכל אפליקציה, כדי שאפליקציות שונות לא יחלקו זיכרון.
  var HKEY = 'appnest_asst_hist_' + (CFG.appName || 'app');
  function loadHistory() { try { return JSON.parse(localStorage.getItem(HKEY)) || []; } catch (e) { return []; } }
  function saveHistory() { try { localStorage.setItem(HKEY, JSON.stringify(history.slice(-30))); } catch (e) {} }
  var history = loadHistory(), panelEl = null, bodyEl = null, panelInput = null, panelSend = null, busy = false, open = false;

  function el(tag, css, txt) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (txt != null) e.textContent = txt; return e; }

  // הקראת טקסט בעברית (Text-to-Speech מובנה בדפדפן)
  var activePlayBtn = null;
  function stopSpeak() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (activePlayBtn) { activePlayBtn.textContent = '🔊'; activePlayBtn = null; }
  }
  function speak(text, btn) {
    if (!window.speechSynthesis) return;
    stopSpeak();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'he-IL'; u.rate = 1;
    u.onend = function () { if (btn) btn.textContent = '🔊'; if (activePlayBtn === btn) activePlayBtn = null; };
    if (btn) { btn.textContent = '⏹'; activePlayBtn = btn; }
    window.speechSynthesis.speak(u);
  }

  function addBubble(role, text) {
    var wrap = el('div', 'display:flex;align-items:flex-end;gap:5px;margin:8px 0;' + (role === 'user' ? 'justify-content:flex-start;' : 'justify-content:flex-end;'));
    var b = el('div',
      'max-width:82%;padding:9px 13px;border-radius:14px;font:14px/1.5 "Segoe UI",sans-serif;white-space:pre-wrap;word-break:break-word;direction:rtl;' +
      (role === 'user'
        ? 'background:#2a2a33;color:#eee;border-top-right-radius:4px;'
        : 'background:#C9A84C;color:#0B0B0F;border-top-left-radius:4px;'), text);
    if (role === 'bot' && window.speechSynthesis) {
      var play = el('button', 'background:none;border:none;cursor:pointer;font-size:15px;opacity:.6;padding:2px;flex-shrink:0;', '🔊');
      play.title = 'הקרא / עצור';
      play.onclick = function () {
        // אם הכפתור הזה כרגע מקריא — עצור. אחרת — התחל להקריא (ועצור כל הקראה אחרת).
        if (activePlayBtn === play) stopSpeak();
        else speak(b.textContent, play);
      };
      wrap.appendChild(play);
    }
    if (role === 'bot') {
      var copy = el('button', 'background:none;border:none;cursor:pointer;font-size:14px;opacity:.6;padding:2px;flex-shrink:0;', '📋');
      copy.title = 'העתק';
      copy.onclick = function () {
        var txt = b.textContent;
        var done = function () { copy.textContent = '✓'; setTimeout(function () { copy.textContent = '📋'; }, 1400); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () {});
        else { try { var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); } catch (e) {} }
      };
      wrap.appendChild(copy);
    }
    wrap.appendChild(b); bodyEl.appendChild(wrap); bodyEl.scrollTop = bodyEl.scrollHeight;
    return b;
  }

  function setBusy(v) {
    busy = v;
    if (panelSend) { panelSend.disabled = v; panelSend.style.opacity = v ? '.5' : '1'; panelSend.textContent = v ? '…' : 'שלח'; }
    if (panelInput) { panelInput.disabled = v; }
  }

  async function send(input) {
    if (busy) return;                          // מונע שליחה כפולה בזמן שהעוזר עונה
    var msg = input.value.trim(); if (!msg) return;
    input.value = ''; addBubble('user', msg);
    var thinking = addBubble('bot', '…חושב');
    setBusy(true);
    try {
      var prompt = buildPrompt(history, msg);
      var raw = await callAI(prompt);
      var parsed = parseReply(raw);
      thinking.textContent = parsed.text || '✓';
      history.push({ role: 'user', text: msg });
      history.push({ role: 'bot', text: parsed.text });
      if (history.length > 30) history = history.slice(-30);
      saveHistory();
      // מבצע את הפעולות לפי הסדר, עם השהיה קטנה בין פעולות כדי לתת למסך להתעדכן
      for (var ai = 0; ai < parsed.actions.length; ai++) {
        var fb = runAction(parsed.actions[ai]);
        if (fb) addBubble('bot', fb);
        else addBubble('bot', 'ניסיתי לבצע פעולה אבל לא מצאתי את היעד באפליקציה.');
        if (ai < parsed.actions.length - 1) await new Promise(function (r) { setTimeout(r, 450); });
      }
    } catch (e) {
      if (e.message === 'NO_AI') thinking.textContent = 'כדי לדבר איתי, חבר קודם מפתח AI בהגדרות הבינה של האפליקציה 🔌';
      else thinking.textContent = 'אופס, משהו השתבש: ' + e.message;
    } finally {
      setBusy(false);
      if (panelInput) panelInput.focus();
    }
  }

  function addSuggestions(inp) {
    var sugg = CFG.suggestions || [];
    if (!sugg.length) return;
    var row = el('div', 'display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;margin:4px 0 8px;');
    sugg.forEach(function (s) {
      var chip = el('button', 'background:#1e1e26;color:#C9A84C;border:1px solid #C9A84C55;border-radius:14px;padding:6px 11px;font:13px "Segoe UI",sans-serif;cursor:pointer;direction:rtl;', s);
      chip.onclick = function () { inp.value = s; row.remove(); send(inp); };
      row.appendChild(chip);
    });
    bodyEl.appendChild(row); bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function buildPanel() {
    panelEl = el('div', 'position:fixed;bottom:78px;left:16px;width:340px;max-width:calc(100vw - 32px);height:460px;max-height:calc(100vh - 120px);' +
      'background:#141418;border:1px solid #2e2e38;border-radius:16px;z-index:100000;display:none;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.55);');
    var head = el('div', 'padding:12px 14px;background:linear-gradient(90deg,#1a1a20,#141418);border-bottom:1px solid #2e2e38;display:flex;align-items:center;gap:8px;');
    head.appendChild(el('span', 'font-size:17px;', '🪄'));
    head.appendChild(el('span', 'color:#C9A84C;font:600 15px "Segoe UI",sans-serif;', 'עוזר ' + CFG.appName));
    var clr = el('span', 'margin-right:auto;cursor:pointer;color:#888;font-size:15px;line-height:1;', '🗑️');
    clr.title = 'נקה שיחה';
    clr.onclick = clearChat;
    head.appendChild(clr);
    var x = el('span', 'cursor:pointer;color:#888;font-size:20px;line-height:1;', '×');
    x.onclick = toggle; head.appendChild(x);
    bodyEl = el('div', 'flex:1;overflow-y:auto;padding:12px;');
    var foot = el('div', 'padding:10px;border-top:1px solid #2e2e38;display:flex;gap:8px;align-items:center;');
    var inp = el('input', 'flex:1;background:#0d0d11;border:1px solid #2e2e38;border-radius:20px;padding:9px 14px;color:#eee;font:14px "Segoe UI",sans-serif;direction:rtl;outline:none;');
    inp.placeholder = 'שאל אותי משהו, או בקש עזרה…';
    inp.onkeydown = function (ev) { if (ev.key === 'Enter') send(inp); };
    // כפתור מיקרופון — דיבור לטקסט (Web Speech API, חינם, מובנה בדפדפן)
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      var rec = new SR();
      rec.lang = 'he-IL'; rec.interimResults = false; rec.maxAlternatives = 1;
      var listening = false, micGranted = false;
      var mic = el('button', 'background:#2a2a33;color:#C9A84C;border:none;border-radius:50%;width:38px;height:38px;font-size:17px;cursor:pointer;flex-shrink:0;', '🎤');
      mic.title = 'דבר במקום להקליד';
      rec.onresult = function (e) { inp.value = e.results[0][0].transcript; inp.focus(); };
      rec.onend = function () { listening = false; mic.style.background = '#2a2a33'; };
      rec.onerror = function (ev) {
        listening = false; mic.style.background = '#2a2a33';
        if (ev && (ev.error === 'not-allowed' || ev.error === 'service-not-allowed'))
          addBubble('bot', 'אין לי גישה למיקרופון. אשר את ההרשאה בהגדרות הדפדפן (ליד כתובת האתר) ונסה שוב 🎤');
        else if (ev && ev.error === 'no-speech')
          addBubble('bot', 'לא שמעתי כלום — נסה לדבר קצת יותר חזק 🙂');
        else if (ev && ev.error === 'not-supported')
          addBubble('bot', 'זיהוי הדיבור לא נתמך בדפדפן הזה — אפשר פשוט להקליד 🙂');
      };
      mic.onclick = async function () {
        if (listening) { rec.stop(); return; }
        // בקשת הרשאה מפורשת — עוזרת בנייד. אם היא נכשלת, עדיין מנסים rec.start()
        // (חלק מהדפדפנים מבקשים הרשאה דרך rec.start עצמו), וההודעה תגיע מ-onerror.
        if (!micGranted && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          try {
            var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(function (t) { t.stop(); });
            micGranted = true;
          } catch (e) { /* לא עוצרים — נותנים ל-rec.start לנסות, ו-onerror יטפל */ }
        }
        try { rec.start(); listening = true; mic.style.background = '#C9A84C'; }
        catch (e) { listening = false; addBubble('bot', 'לא הצלחתי להפעיל את המיקרופון — אפשר פשוט להקליד 🙂'); }
      };
      foot.appendChild(mic);
    }
    var snd = el('button', 'background:#C9A84C;color:#0B0B0F;border:none;border-radius:20px;padding:0 16px;height:38px;font:600 14px "Segoe UI",sans-serif;cursor:pointer;flex-shrink:0;', 'שלח');
    snd.onclick = function () { send(inp); };
    foot.appendChild(inp); foot.appendChild(snd);
    panelEl.appendChild(head); panelEl.appendChild(bodyEl); panelEl.appendChild(foot);
    document.body.appendChild(panelEl);
    panelInput = inp; panelSend = snd;
    renderConversation();
  }

  // מציג את השיחה בגוף החלון: היסטוריה שמורה אם יש, אחרת הודעת פתיחה + הצעות.
  function renderConversation() {
    bodyEl.innerHTML = '';
    if (history.length) {
      history.forEach(function (m) { addBubble(m.role === 'user' ? 'user' : 'bot', m.text); });
    } else {
      addBubble('bot', 'היי! אני העוזר של ' + CFG.appName + '. אפשר לשאול אותי כל דבר, לבקש שאכתוב תוכן ישר לאפליקציה, או לעזור לך למצוא דברים. במה אעזור?');
      if (panelInput) addSuggestions(panelInput);
    }
  }

  function clearChat() {
    history = []; saveHistory(); stopSpeak();
    renderConversation();
  }

  function toggle() {
    if (!panelEl) buildPanel();
    open = !open;
    panelEl.style.display = open ? 'flex' : 'none';
  }

  function addButton() {
    if (document.getElementById('appnest-assistant-btn')) return;
    var b = el('button', 'position:fixed;bottom:16px;left:16px;z-index:100000;background:#C9A84C;color:#0B0B0F;border:none;' +
      'border-radius:24px;padding:10px 18px;font:600 15px "Segoe UI",sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4);', '🪄 עוזר');
    b.id = 'appnest-assistant-btn';
    b.onclick = toggle;
    document.body.appendChild(b);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addButton);
  else addButton();
})();
