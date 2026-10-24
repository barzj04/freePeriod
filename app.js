(() => {
  const $ = (s) => document.querySelector(s);
  const MIN = 60 * 1000;
  const ico = (n) => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;

  // ---------- storage (safe) ----------
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const drop = (k) => { try { localStorage.removeItem(k); } catch {} };

  const DEFAULT_MODEL = { anthropic: 'claude-haiku-5-5', gemini: 'gemini-2.5-flash' };
  // Shared AI server (Cloudflare Worker in /worker) so judges can use AI without their own key.
  // Paste your Worker URL here after deploying it, e.g. 'https://freeperiod-ai.yourname.workers.dev'
  const PROXY_URL = 'https://freeperiod-proxy.arleenchong.workers.dev';
  let settings = Object.assign({ provider: 'anthropic', key: '', model: DEFAULT_MODEL.anthropic, proxy: '', warn: 5, scale: 1, theme: '' }, load('fp_settings', {}));
  let S = load('fp_state', null); // current session
  let tasks = load('fp_tasks', []); // the user's task list, kept between sessions
  const saveState = () => store('fp_state', S);

  // "3:00 PM", "tomorrow 3:00 PM" or "Fri 24 Oct, 3:00 PM"
  function fmtTime(ms) {
    const d = new Date(ms), t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const day = (x) => new Date(x).toDateString();
    if (day(ms) === day(Date.now())) return t;
    if (day(ms) === day(Date.now() + 864e5)) return `tomorrow ${t}`;
    return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${t}`;
  }
  // "42 min" or "3 h 15 min"
  function fmtDur(min) {
    if (min < 90) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const toLocalInput = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const minsLeft = (ms) => Math.floor((ms - Date.now()) / MIN);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function applySettings() {
    document.documentElement.style.setProperty('--scale', settings.scale);
    if (settings.theme) document.documentElement.dataset.theme = settings.theme;
    else delete document.documentElement.dataset.theme;
  }
  applySettings();

  // ---------- screens ----------
  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => (s.hidden = s.id !== id));
    const h = document.querySelector(`#${id} [tabindex="-1"]`);
    if (h) h.focus({ preventScroll: false });
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 8000);
  }
  const announce = (msg) => ($('#live').textContent = msg);

  // ---------- sound + notifications ----------
  let ctx = null;
  function ensureAudio() {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
    } catch {}
  }
  function tone(freq, start, dur, type = 'sine', vol = 0.2) {
    if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
    g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
    o.connect(g).connect(ctx.destination);
    o.start(ctx.currentTime + start); o.stop(ctx.currentTime + start + dur + 0.05);
  }
  const chime = () => { tone(660, 0, 0.5); tone(880, 0.25, 0.7); };
  let alarmLoop = null;
  function startAlarmSound() {
    stopAlarmSound();
    const beep = () => { tone(880, 0, 0.18, 'square', 0.35); tone(880, 0.25, 0.18, 'square', 0.35); tone(1175, 0.5, 0.3, 'square', 0.35); };
    beep();
    alarmLoop = setInterval(beep, 1200);
    if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
  }
  function stopAlarmSound() { clearInterval(alarmLoop); alarmLoop = null; }
  function notify(title, body) {
    try {
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        new Notification(title, { body, requireInteraction: true });
      }
    } catch {}
  }

  // ---------- built-in planner (no AI needed) ----------
  const TEMPLATES = [
    { re: /\b(write|essay|report|chapter|draft|thesis|paper|article|proposal|assignment|story|devpost)\b/i, steps: [
      ['Open the document and re-read the last paragraph you wrote', 3],
      ['List 3 bullet points this part needs to say', 5],
      ['Turn bullet 1 into rough sentences. Messy is fine', 10],
      ['Turn bullet 2 into rough sentences', 10],
      ['Add one source or example to back up a point', 8],
      ['Leave a note at the end: what to write next', 2]] },
    { re: /\b(study|revise|revision|exam|test|quiz|read|reading|notes|lecture|learn|memori[sz]e|tutorial)\b/i, steps: [
      ['Get out the notes or slides for just one topic', 3],
      ['Skim the headings and pick the 3 key ideas', 7],
      ['Explain idea 1 in 3 sentences without looking', 8],
      ['Do 3 practice questions on that topic', 12],
      ['Write down the one thing you still don\'t get', 3]] },
    { re: /\b(code|coding|bug|debug|fix|build|implement|feature|app|website|function|deploy|api|script|project)\b/i, steps: [
      ['Open the project and run it once', 5],
      ['Write a one-line comment saying what you\'ll change', 2],
      ['Find the file or function where it goes', 5],
      ['Make the smallest change that moves it forward', 12],
      ['Run it again and note what happened', 5],
      ['Commit with a short message', 2]] },
    { re: /\b(email|reply|message|text|call|contact|follow.?up|apply|application)\b/i, steps: [
      ['Open the message or a blank draft', 2],
      ['Write one sentence saying what you need', 3],
      ['Add the details or dates they need', 5],
      ['Read it once and send it', 3]] },
    { re: /\b(clean|tidy|laundry|organi[sz]e|declutter|dishes|room|pack)\b/i, steps: [
      ['Pick one small area, just one', 2],
      ['Put away things that belong somewhere else', 8],
      ['Throw away obvious rubbish', 5],
      ['Wipe or reset that one area', 5]] }
  ];
  const GENERIC = [
    ['Open whatever you need to start', 3],
    ['Write what "done" looks like in one sentence', 3],
    ['List the first 3 tiny actions', 5],
    ['Do tiny action 1', 10],
    ['Do tiny action 2', 10],
    ['Note where you stopped for next time', 2]
  ];
  function localSteps(task, energy) {
    const tpl = (TEMPLATES.find((t) => t.re.test(task)) || { steps: GENERIC }).steps;
    const f = energy === 'low' ? 0.6 : 1;
    return tpl.map(([text, m]) => ({ text, minutes: Math.max(2, Math.round(m * f)), task }));
  }
  const localPlan = (list, energy) => list.flatMap((t) => localSteps(t, energy));
  function localSplit(step) {
    const half = Math.max(2, Math.round(step.minutes / 2));
    return [
      { text: 'Get set up: open what you need for this step', minutes: 2 },
      { text: `Do only the very first bit: ${step.text.charAt(0).toLowerCase() + step.text.slice(1)}`, minutes: half },
      { text: 'Stop and jot down what the next bit is', minutes: 2 }
    ].map((s) => ({ ...s, task: step.task }));
  }

  // Fill the window: tasks in priority order, steps kept in order within a task.
  // If a task's next step doesn't fit, stop that task and let a later (quicker) task fill the leftover minutes.
  function pack(steps, gap) {
    const fit = [], rest = [], blocked = new Set();
    let used = 0;
    for (const s of steps) {
      if (!blocked.has(s.task) && used + s.minutes <= gap) { fit.push(s); used += s.minutes; }
      else { blocked.add(s.task); rest.push(s); }
    }
    return [...fit, ...rest];
  }

  // ---------- AI (your own key, or the shared server) ----------
  const JSON_RULE = '\nRespond only with JSON, no other text: {"steps":[{"text":string,"minutes":number}]}';
  const proxyUrl = () => (settings.proxy || PROXY_URL).trim();
  const aiMode = () => (settings.key ? 'own' : proxyUrl() ? 'shared' : null);

  // files: [{ type: 'image/jpeg' | 'application/pdf' | ..., data: base64 }]
  async function callAnthropic(prompt, files = [], maxTokens = 2000) {
    const content = [
      ...files.map((f) => f.type === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: f.type, data: f.data } }
        : { type: 'image', source: { type: 'base64', media_type: f.type, data: f.data } }),
      { type: 'text', text: prompt }
    ];
    const own = aiMode() === 'own';
    const res = await fetch(own ? 'https://api.anthropic.com/v1/messages' : proxyUrl(), {
      method: 'POST',
      headers: own
        ? { 'content-type': 'application/json', 'x-api-key': settings.key, 'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true' } // allows calling from a browser page
        : { 'content-type': 'application/json' },
      body: JSON.stringify({ model: own ? settings.model : undefined, max_tokens: maxTokens, messages: [{ role: 'user', content }] })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error('the shared AI server hit today\'s limit');
    if (!res.ok) throw new Error(`${res.status}: ${data.error?.message || res.statusText}`);
    if (data.stop_reason === 'max_tokens') throw new Error('reply was cut off');
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  async function callGemini(prompt, files = []) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.key },
      body: JSON.stringify({
        contents: [{ parts: [...files.map((f) => ({ inline_data: { mime_type: f.type, data: f.data } })), { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status}: ${data.error?.message || res.statusText}`);
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  // Ask the AI and return parsed JSON, or null (with a toast saying why) so callers fall back.
  async function aiJSON(prompt, label, files = [], maxTokens = 2000) {
    if (!aiMode()) return null;
    try {
      const text = aiMode() === 'own' && settings.provider === 'gemini'
        ? await callGemini(prompt, files) : await callAnthropic(prompt, files, maxTokens);
      const raw = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1); // tolerate stray text
      return JSON.parse(raw);
    } catch (e) {
      const why = e instanceof SyntaxError ? 'the reply wasn\'t valid JSON'
        : e.message === 'Failed to fetch' ? 'no connection to the AI (check internet, or open the page from a web address instead of a file)'
        : e.message;
      console.warn('FreePeriod AI error:', e);
      toast(`AI ${label} unavailable (${why}).`);
      return null;
    }
  }

  // Read an uploaded image or PDF as base64. Big photos are shrunk so uploads stay fast.
  function readForAI(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('no file'));
      if (file.size > 8 * 1024 * 1024) return reject(new Error('That file is over 8 MB. Try a smaller photo or PDF.'));
      const r = new FileReader();
      r.onerror = () => reject(new Error('Couldn\'t read that file.'));
      r.onload = () => {
        const url = String(r.result);
        if (file.type === 'application/pdf' || !file.type.startsWith('image/')) {
          return resolve({ type: file.type || 'application/pdf', data: url.split(',')[1] });
        }
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve({ type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] });
        };
        img.onerror = () => reject(new Error('Couldn\'t open that image.'));
        img.src = url;
      };
      r.readAsDataURL(file);
    });
  }

  async function aiSteps(prompt) {
    const j = await aiJSON(prompt + JSON_RULE, 'planner');
    const steps = ((j && j.steps) || [])
      .filter((s) => s && s.text)
      .map((s) => ({ text: String(s.text).slice(0, 140), minutes: clamp(Math.round(+s.minutes || 5), 1, 30), task: s.task }));
    return steps.length ? steps : null;
  }
  const planPrompt = (list, gap, energy) =>
    `A student with ADHD is stuck and can't start. Their tasks, most important first:\n` +
    list.map((t, i) => `${i}. ${t}`).join('\n') +
    examContext() +
    `\nThey have ${gap} minutes before they must leave for something else. ` +
    `Energy: ${energy === 'low' ? 'low, so make steps tiny and gentle' : 'okay'}. ` +
    `Write 2 to 5 concrete steps per task that they can start immediately, each 2 to 15 minutes. ` +
    `Order all steps so the ones done first fit within ${gap} minutes: start with the most important task, ` +
    `and use quick steps from other tasks to fill any leftover minutes. Each step starts with a verb and is under 15 words. ` +
    `Give each step a "task" field with the task's number.` +
    (pace() !== 1 ? ` This student usually takes ${pace()}x as long as estimated, so size the minutes for them.` : '');
  const splitPrompt = (step) =>
    `A student with ADHD finds this step too hard to start: "${step.text}" (part of the task "${step.task}", about ${step.minutes} minutes). ` +
    `Break it into 2 or 3 much smaller, concrete steps. The first must take 2 minutes or less. Each starts with a verb and is under 12 words.`;
  const dumpPrompt = (text) =>
    `A student with ADHD did a voice brain dump. It may be messy, rambling, or mix English and Malay:\n"""${text}"""\n` +
    `Turn it into a clear task list. Merge duplicates, drop filler words and feelings, and keep only things they need to do. ` +
    `Each task starts with a verb, is under 10 words, and keeps the user's own language and names. ` +
    `Order by importance and urgency, most important first.\n` +
    `Respond only with JSON, no other text: {"tasks":[string]}`;

  // ---------- brain dump: speech → task list ----------
  const FILLER = /^(?:(?:um+|uh+|erm+|ugh+|okay|ok|so|and|also|then|like|well|oh|hmm+|right|basically|dan|lepas tu|pastu)[,\s]+)+/i;
  const LEAD = /^(?:(?:i|saya|aku)\s+)?(?:really\s+|still\s+|also\s+|kinda\s+)?(?:need|have|got|gotta|must|should|want|ought|perlu|kena|nak|mesti|harus)\s+(?:to\s+)?|^(?:remember|don'?t forget|jangan lupa)\s+(?:to\s+)?/i;
  const VERBS = 'i|need|have|also|then|reply|finish|do|send|call|email|text|study|revise|write|clean|book|pay|buy|submit|read|fix|prepare|check|go|make|update|plan|print|wash|cook|start|practise|practice|review|apply|ask|meet|return|sort|pack|tidy|order|renew|upload|record|kena|perlu|nak';
  function localParse(text) {
    const seen = new Set();
    return text
      .split(new RegExp(`[\\n.;!?]+|,|\\band then\\b|\\bthen\\b|\\balso\\b|\\blepas tu\\b|\\b(?:and|dan)\\b(?=\\s+(?:${VERBS})\\b)`, 'i'))
      .map((p) => {
        let s = (p || '').trim();
        for (let i = 0; i < 3; i++) s = s.replace(FILLER, '').replace(LEAD, '').trim();
        return s.replace(/^[-–•*]+\s*/, '').replace(/\s+/g, ' ');
      })
      .filter((s) => s.split(' ').length >= 2 || s.length >= 6)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .filter((s) => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 12);
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, listening = false, finalText = '';
  const micStatus = (m) => ($('#micStatus').textContent = m);
  function setMic(on) {
    $('#micBtn').setAttribute('aria-pressed', String(on));
    $('#micBtn').innerHTML = on ? `${ico('stop')}Stop` : `${ico('mic')}Start talking`;
    if (!on) $('#dumpInterim').textContent = '';
  }
  function startMic() {
    if (!SR) return micStatus('Voice input isn\'t supported in this browser. Try Chrome or Edge, or type below.');
    try {
      rec = new SR();
      rec.lang = $('#dumpLang').value;
      rec.continuous = true;
      rec.interimResults = true;
      finalText = $('#dumpText').value.trim();
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) {
            finalText = (finalText ? finalText + ' ' : '') + r[0].transcript.trim();
            $('#dumpText').value = finalText;
          } else interim += r[0].transcript;
        }
        $('#dumpInterim').textContent = interim;
      };
      rec.onerror = (e) => {
        const msg = {
          'not-allowed': 'Microphone blocked. Allow it from the icon in the address bar, or type below.',
          'service-not-allowed': 'Voice isn\'t allowed here. Type below instead.',
          'audio-capture': 'No microphone found. Type below instead.',
          'network': 'Voice input needs an internet connection in this browser. Type below instead.'
        }[e.error];
        if (msg) { listening = false; micStatus(msg); }
      };
      rec.onend = () => {
        if (listening) { try { rec.start(); } catch { listening = false; setMic(false); } } // Chrome stops after a pause
        else setMic(false);
      };
      listening = true;
      rec.start();
      setMic(true);
      micStatus('Listening… say it all, in any order. Press Stop when you\'re done.');
    } catch {
      listening = false; setMic(false);
      micStatus('Couldn\'t start the microphone. Type below instead.');
    }
  }
  function stopMic() {
    listening = false;
    try { rec && rec.stop(); } catch {}
    setMic(false);
  }

  $('#dumpBtn').addEventListener('click', () => {
    $('#dumpText').value = '';
    $('#dumpInterim').textContent = '';
    micStatus(SR ? '' : 'Voice input isn\'t supported in this browser, but you can type below.');
    $('#dumpDlg').showModal();
    $('#micBtn').focus();
  });
  $('#micBtn').addEventListener('click', () => (listening ? stopMic() : startMic()));
  $('#dumpText').addEventListener('input', () => (finalText = $('#dumpText').value.trim()));
  $('#dumpCancel').addEventListener('click', () => $('#dumpDlg').close());
  $('#dumpDlg').addEventListener('close', stopMic);
  $('#dumpGo').addEventListener('click', async () => {
    stopMic();
    const text = $('#dumpText').value.trim();
    if (!text) return micStatus('Say or type something first. Even one messy sentence is enough.');
    const b = $('#dumpGo');
    b.disabled = true; b.textContent = 'Sorting it out…';
    const j = await aiJSON(dumpPrompt(text), 'list maker');
    let found = ((j && j.tasks) || []).map((t) => String(t.text || t).trim()).filter(Boolean);
    if (!found.length) found = localParse(text);
    b.disabled = false; b.textContent = 'Make my list';
    if (!found.length) return micStatus('I couldn\'t find any tasks in that. Try saying what you need to do.');

    const have = new Set(tasks.map((t) => t.toLowerCase()));
    const added = found.filter((t) => !have.has(t.toLowerCase())).map((t) => t.slice(0, 120));
    tasks.push(...added);
    store('fp_tasks', tasks);
    $('#dumpDlg').close();
    renderTasks();
    toast(added.length
      ? `Added ${added.length} task${added.length === 1 ? '' : 's'}. Put the most important one at the top.`
      : 'Those tasks are already on your list.');
    announce(`Added ${added.length} tasks.`);
  });


  // ================= FreePeriod features =================

  // ---------- timetable → free periods ----------
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let timetable = load('fp_timetable', null); // { classes: [{day,start,end,name}], exams: [{date,name}], sample? }
  const hm = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  const ttPrompt = () =>
    `This is a university student's class timetable and/or course syllabus. Today is ${new Date().toDateString()}.\n` +
    `Extract (1) weekly recurring classes and (2) any exam, test, quiz or assignment due dates.\n` +
    `Use 24-hour HH:MM times and 3-letter English day names. If a class has no end time, assume 1 hour. ` +
    `Use YYYY-MM-DD for dates; if a date has no year, use the next upcoming one. Keep names short (under 5 words). ` +
    `If something is unreadable, leave it out rather than guessing.\n` +
    `Respond only with JSON, no other text: {"classes":[{"day":"Mon","start":"09:00","end":"11:00","name":"Machine Learning"}],"exams":[{"date":"2026-11-10","name":"ML midterm"}]}`;

  function cleanTimetable(j) {
    const okDay = (d) => DAYS.find((x) => x.toLowerCase() === String(d || '').slice(0, 3).toLowerCase());
    const okTime = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return !!m && +m[1] < 24 && +m[2] < 60; };
    const plusHour = (t) => `${pad2(Math.floor((hm(t) + 60) / 60) % 24)}:${pad2((hm(t) + 60) % 60)}`;
    const classes = ((j && j.classes) || [])
      .map((c) => ({ day: okDay(c.day), start: c.start, end: c.end || '', name: String(c.name || 'Class').slice(0, 40) }))
      .filter((c) => c.day && okTime(c.start))
      .map((c) => ({ ...c, end: okTime(c.end) && hm(c.end) > hm(c.start) ? c.end : plusHour(c.start) }));
    const exams = ((j && j.exams) || [])
      .map((e) => ({ date: String(e.date || ''), name: String(e.name || 'Exam').slice(0, 40) }))
      .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date));
    return { classes, exams };
  }

  function sampleTimetable() {
    const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
    return {
      sample: true,
      classes: [
        { day: 'Mon', start: '09:00', end: '11:00', name: 'Machine Learning' }, { day: 'Mon', start: '15:00', end: '17:00', name: 'Data Visualization' },
        { day: 'Tue', start: '10:00', end: '12:00', name: 'Cloud Computing' }, { day: 'Tue', start: '16:00', end: '17:00', name: 'Business Accounting' },
        { day: 'Wed', start: '09:00', end: '10:00', name: 'Machine Learning' }, { day: 'Wed', start: '14:00', end: '16:00', name: 'Big Data Analytics' },
        { day: 'Thu', start: '11:00', end: '13:00', name: 'Parallel Computing' }, { day: 'Thu', start: '16:00', end: '18:00', name: 'FYP meeting' },
        { day: 'Fri', start: '08:00', end: '10:00', name: 'Data Visualization' }, { day: 'Fri', start: '14:30', end: '16:30', name: 'Cloud Computing' },
        { day: 'Sat', start: '10:00', end: '11:00', name: 'Study group' }, { day: 'Sun', start: '19:00', end: '20:00', name: 'Weekly review' }
      ],
      exams: [{ date: inDays(6), name: 'ML quiz' }, { date: inDays(13), name: 'Cloud Computing midterm' }]
    };
  }

  // Free periods on one day = time before each class (from the previous class, 8am, or now) that's at least 20 min.
  function periodsForDay(day) {
    const now = Date.now(), out = [];
    const todays = timetable.classes.filter((c) => c.day === DAYS[day.getDay()]).sort((a, b) => hm(a.start) - hm(b.start));
    let free = day.getTime() + 8 * 60 * MIN;
    for (const c of todays) {
      const start = day.getTime() + hm(c.start) * MIN, end = day.getTime() + hm(c.end) * MIN;
      const from = Math.max(free, now);
      if (start - from >= 20 * MIN) out.push({ from, to: start, name: c.name, now: from === now });
      free = Math.max(free, end);
    }
    return out;
  }
  // Monday to Sunday, `offset` weeks from this one
  function weekDays(offset = 0) {
    const mon = new Date(); mon.setHours(0, 0, 0, 0);
    mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7) + offset * 7);
    return Array.from({ length: 7 }, (_, d) => { const x = new Date(mon); x.setDate(mon.getDate() + d); return x; });
  }

  function upcomingExams() {
    if (!timetable) return [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return timetable.exams
      .map((e) => ({ ...e, days: Math.round((new Date(e.date + 'T00:00') - today) / 864e5) }))
      .filter((e) => e.days >= 0)
      .sort((a, b) => a.days - b.days);
  }
  const inWords = (n) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`);
  function examContext() {
    const ex = upcomingExams().slice(0, 4);
    return ex.length ? `\nUpcoming exams: ${ex.map((e) => `${e.name} ${inWords(e.days)}`).join('; ')}. Put steps for tasks linked to the nearest exam first.` : '';
  }
  // Built-in planner: move tasks that mention the nearest exam's subject to the top.
  function examFirst(list) {
    const ex = upcomingExams()[0];
    if (!ex) return list;
    const skip = ['quiz', 'exam', 'test', 'midterm', 'final', 'finals'];
    const words = ex.name.toLowerCase().split(/\W+/).filter((w) => w.length >= 2 && !skip.includes(w));
    const hits = (t) => words.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(t));
    return [...list.filter(hits), ...list.filter((t) => !hits(t))];
  }

  // ---------- week calendar ----------
  const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function renderWeek() {
    const has = !!(timetable && timetable.classes.length);
    $('#ttFull').hidden = !has;
    $('#ttEmpty').hidden = has;
    $('#ttEditBtn').hidden = !has;
    $('#ttSample').hidden = has;
    $('#ttUploadLabel').textContent = has ? 'Upload a new one' : 'Upload timetable';
    $('#weekSub').textContent = has
      ? (timetable.sample ? 'This is a sample week. Upload yours to see your real free time.' : 'Shaded blocks are free time between classes. Tap one to plan it.')
      : 'Upload your timetable and I\'ll show you the free time between your classes.';
    if (!has) return;

    // hours shown: from 8am (or earliest class) to 6pm (or latest class)
    const startH = Math.min(8, ...timetable.classes.map((c) => Math.floor(hm(c.start) / 60)));
    const endH = Math.max(18, ...timetable.classes.map((c) => Math.ceil(hm(c.end) / 60)));
    const PX = 60; // pixels per hour
    const days = weekDays(weekOffset);
    const exams = upcomingExams();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const plan = thisPlan();
    const cal = $('#cal');
    cal.innerHTML = '';
    cal.style.setProperty('--rows', endH - startH);
    cal.style.setProperty('--hour', PX + 'px');

    const gutter = document.createElement('div');
    gutter.className = 'cal-gutter';
    gutter.innerHTML = '<div class="cal-dh"></div>';
    for (let h = startH; h < endH; h++) {
      const t = document.createElement('div');
      t.className = 'cal-hr';
      t.textContent = new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
      gutter.append(t);
    }
    cal.append(gutter);

    days.forEach((day, i) => {
      const col = document.createElement('div');
      const isToday = day.getTime() === today.getTime();
      col.className = 'cal-day' + (isToday ? ' today' : '');
      const head = document.createElement('div');
      head.className = 'cal-dh';
      head.innerHTML = '<b></b><span></span>';
      head.querySelector('b').textContent = isToday ? 'Today' : day.toLocaleDateString([], { weekday: 'short' });
      head.querySelector('span').textContent = day.getDate();
      const dayExams = exams.filter((e) => e.date === ymd(day));
      dayExams.forEach((e) => {
        const tag = document.createElement('em');
        tag.className = 'cal-exam'; tag.textContent = e.name;
        head.append(tag);
      });
      col.append(head);
      const body = document.createElement('div');
      body.className = 'cal-body';
      const top = (ms) => ((ms - day.getTime()) / MIN / 60 - startH) * PX;
      const place = (el, from, to) => { el.style.top = top(from) + 'px'; el.style.height = Math.max(18, top(to) - top(from) - 2) + 'px'; };

      if (day.getTime() <= today.getTime()) { // grey out time that's already gone
        const past = document.createElement('div');
        past.className = 'cal-past';
        past.style.height = (isToday ? clamp(top(Date.now()), 0, (endH - startH) * PX) : (endH - startH) * PX) + 'px';
        body.append(past);
      }
      timetable.classes.filter((c) => c.day === DAYS[day.getDay()]).forEach((c) => {
        const b = document.createElement('div');
        b.className = 'cal-class';
        place(b, day.getTime() + hm(c.start) * MIN, day.getTime() + hm(c.end) * MIN);
        b.innerHTML = '<b></b><span></span>';
        b.querySelector('b').textContent = c.name;
        b.querySelector('span').textContent = `${c.start}–${c.end}`;
        body.append(b);
      });
      // free time = each free period minus any study blocks planned inside it
      const dayBlocks = (plan ? plan.blocks : []).filter((x) => ymd(new Date(x.from)) === ymd(day)).sort((a, c) => a.from - c.from);
      periodsForDay(day).flatMap((g) => {
        const segs = []; let cur = g.from;
        dayBlocks.filter((x) => x.from < g.to && x.to > g.from).forEach((x) => {
          // free time before a study block: plan it up to when that block starts
          if (x.from - cur >= 20 * MIN) segs.push({ ...g, from: cur, to: x.from, name: `your ${x.subject} study block` });
          cur = Math.max(cur, x.to);
        });
        if (g.to - cur >= 20 * MIN) segs.push({ ...g, from: cur });
        return segs;
      }).forEach((g) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cal-free';
        place(b, g.from, g.to);
        const mins = Math.round((g.to - g.from) / MIN);
        b.innerHTML = '<b></b><span></span>';
        b.querySelector('b').textContent = fmtDur(mins);
        b.querySelector('span').textContent = 'free';
        b.setAttribute('aria-label', `${day.toLocaleDateString([], { weekday: 'long' })} ${hhmm(g.from)}: ${fmtDur(mins)} free before ${g.name}. Plan it.`);
        b.addEventListener('click', () => openFree(g));
        body.append(b);
      });
      (plan ? plan.blocks : []).filter((x) => ymd(new Date(x.from)) === ymd(day)).forEach((x) => {
        const b = document.createElement('button');
        b.type = 'button';
        const missed = x.status === 'todo' && x.to < Date.now();
        b.className = 'cal-study' + (x.status === 'done' ? ' done' : missed ? ' missed' : '');
        place(b, x.from, x.to);
        b.innerHTML = '<b></b><span></span>';
        b.querySelector('b').textContent = (x.status === 'done' ? '✓ ' : '') + x.subject;
        b.querySelector('span').textContent = x.what;
        b.title = `${hhmm(x.from)}–${hhmm(x.to)}, ${x.subject}: ${x.what}`;
        b.setAttribute('aria-label', `${x.status === 'done' ? 'Done: ' : missed ? 'Missed: ' : ''}${day.toLocaleDateString([], { weekday: 'long' })} ${hhmm(x.from)} to ${hhmm(x.to)}, ${x.subject}: ${x.what}`);
        b.addEventListener('click', () => openBlock(x));
        body.append(b);
      });
      col.append(body);
      cal.append(col);
    });

    renderStudyPlan();
    $('#examLine').innerHTML = '';
    const soon = exams.filter((e) => e.days <= 30).slice(0, 3);
    if (soon.length) {
      const strong = document.createElement('strong'); strong.textContent = 'Exams coming up: ';
      $('#examLine').append(strong, soon.map((e) => `${e.name} ${inWords(e.days)}`).join(', '));
    }
  }

  let pickedGap = null, pickedBlock = null;
  function useGap(g, blockId = null) {
    if (S && S.running) { switchTab('plan'); toast('You\'re in the middle of a session. Finish or end it first.'); return; }
    if (S) { S = null; drop('fp_state'); initSetup(); }
    pickedGap = g; pickedBlock = blockId;
    if (blockId) { $('#useLater').checked = false; $('#taskWrap').hidden = false; } // a study block brings its own task
    renderTasks();
    show('setup'); switchTab('plan');
    $('#eventName').value = g.name;
    $('#eventTime').value = toLocalInput(new Date(g.to));
    $('#buffer').value = 10;
    toast(`Planning your free time before ${g.name}. Add your tasks, then tap Make my plan.`);
    $('#taskInput').focus();
  }

  // ---------- weekly study plan ----------
  // Weeks run Monday to Sunday. Each week keeps its own plan: { blocks: [...], note, created }.
  let weekOffset = 0;
  let plans = load('fp_plans', {});
  const savePlans = () => store('fp_plans', plans);
  const weekKey = () => ymd(weekDays(weekOffset)[0]);
  const thisPlan = () => plans[weekKey()] || null;
  const NOT_SUBJECT = /\b(study group|group study|review|meeting|club|break|lunch|gym|prayer|solat)\b/i;
  const studySubjects = () => [...new Set(timetable.classes.filter((c) => !NOT_SUBJECT.test(c.name)).map((c) => subjectOf(c.name)))];
  const subjectOf = (name) => name.replace(/\b(lecture|lect|lab|tutorial|tut|class|seminar|practical|meeting)\b/gi, '').replace(/\s+/g, ' ').trim() || name;
  const initials = (t) => t.split(/\s+/).filter((w) => w.length > 2 || /^[A-Z]/.test(w)).map((w) => w[0].toUpperCase()).join('');
  function examFor(subject) {
    const words = subject.toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
    const ini = initials(subject);
    // match when every main word of the subject is in the exam name ("Cloud Computing" ↔ "Cloud Computing midterm"),
    // or its initials are ("Machine Learning" ↔ "ML quiz")
    return upcomingExams().find((e) => (words.length && words.every((w) => e.name.toLowerCase().includes(w))) || (ini.length >= 2 && new RegExp(`\\b${ini}\\b`).test(e.name)));
  }
  // Free periods worth studying in (30+ min) for the week on screen, from now on.
  const studyPeriods = () => weekDays(weekOffset).flatMap(periodsForDay).filter((g) => g.to - g.from >= 30 * MIN);
  const dayCap = (day) => (burnoutSigns().length ? 120 : [0, 6].includes(day.getDay()) ? 120 : 180); // minutes per day

  const studyPrompt = (periods, subjects, catchUp) =>
    `Plan a realistic weekly study timetable for a university student (they may have ADHD). Today is ${new Date().toDateString()}.\n` +
    `Their free periods this week (id | when | minutes free | class right after):\n` +
    periods.map((g, i) => `p${i} | ${new Date(g.from).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} | ${Math.round((g.to - g.from) / MIN)} | ${g.name}`).join('\n') +
    `\nSubjects: ${subjects.join(', ')}.` +
    examContext() +
    (tasks.length ? `\nTheir own to-do list: ${tasks.slice(0, 8).join('; ')}.` : '') +
    (catchUp.length ? `\nThey missed these earlier this week, so fit them back in first: ${catchUp.map((b) => `${b.subject}: ${b.what}`).join('; ')}.` : '') +
    (pace() >= 1.2 ? `\nThey usually need ${pace()}x the time planned, so don't overpack.` : '') +
    (burnoutSigns().length ? `\nThey show signs of burnout, so keep it light: at most 2 hours a day, with more breaks.` : '') +
    `\nRules: don't fill every free period; leave real breaks and keep weekends lighter. At most 3 hours of study a day. ` +
    `Only plan study for real course subjects (skip things like study groups or meetings). ` +
    `Each block is 25 to 90 minutes and must leave at least 10 minutes before the next class. Put subjects with the nearest exams first, ` +
    `and spread the same subject over different days instead of cramming. Say exactly what to do in each block in under 9 words ` +
    `(like "Practice questions: linear regression"). For "note", write one casual line under 12 words about the main priority ` +
    `(like "ML quiz is Friday, so ML comes first."), or leave it empty if there's nothing specific to say. No advice or encouragement.\n` +
    `Respond only with JSON, no other text: {"blocks":[{"period":"p0","minutes":60,"subject":"Machine Learning","what":"Practice questions: regression"}],"note":string}`;

  // Built-in planner: nearest exams first, rotate subjects, cap minutes per day.
  function localStudyPlan(periods, catchUp) {
    const subjects = studySubjects();
    if (!subjects.length) return { blocks: [], note: '' };
    const weight = (s) => { const e = examFor(s); return 1 + (e ? 10 / (e.days + 1) : 0); };
    const count = {}, used = {}, perDay = {}, out = [];
    const queue = catchUp.map((b) => ({ subject: b.subject, what: b.what }));
    const ideas = ['Review this week\'s notes', 'Practice questions', 'Make flashcards', 'Summarise one topic'];
    for (const g of periods) {
      const day = new Date(g.from); day.setHours(0, 0, 0, 0);
      const k = ymd(day);
      used[k] = used[k] || 0; perDay[k] = perDay[k] || 0;
      const maxBlocks = [0, 6].includes(day.getDay()) ? 1 : 2;
      const mins = Math.floor(Math.min((g.to - g.from) / MIN - 10, 60, dayCap(day) - used[k]) / 5) * 5;
      if (mins < 25 || perDay[k] >= maxBlocks || new Date(g.from).getHours() === 12) continue; // keep lunch free
      perDay[k]++;
      let item = queue.shift();
      if (!item) {
        const s = subjects.sort((a, b) => weight(b) / (1 + (count[b] || 0)) - weight(a) / (1 + (count[a] || 0)))[0];
        const e = examFor(s), n = count[s] || 0;
        item = { subject: s, what: e ? `${['Key ideas', 'Practice questions', 'Past paper', 'Flashcards'][n % 4]} for ${e.name}` : `${ideas[n % 4]}` };
      }
      count[item.subject] = (count[item.subject] || 0) + 1;
      used[k] += mins;
      out.push({ g, minutes: mins, ...item });
    }
    const ex = upcomingExams()[0];
    return { blocks: out, note: ex && ex.days <= 14 ? `${ex.name} is ${inWords(ex.days)}, so it gets the most time.` : 'Spread out so you\'re not cramming.' };
  }

  async function makeStudyPlan(replan) {
    const plan = thisPlan();
    const keep = replan && plan ? plan.blocks.filter((b) => b.status === 'done') : []; // finished blocks stay put
    const catchUp = replan && plan ? plan.blocks.filter((b) => b.status === 'todo' && b.to < Date.now()) : [];
    const periods = studyPeriods();
    if (!periods.length) { toast('There\'s no free time left this week to plan.'); return; }
    const b = $('#splanBtn');
    b.disabled = true; $('#splanReplan').disabled = true;
    $('#splanText').textContent = replan ? 'Moving things around…' : 'Planning your week…';
    const subjects = studySubjects();
    let raw = null;
    const j = await aiJSON(studyPrompt(periods, subjects, catchUp), 'study planner', [], 3000);
    if (j && Array.isArray(j.blocks)) {
      raw = { note: String(j.note || ''), blocks: j.blocks.map((x) => ({ ...x, g: periods[+String(x.period).replace(/\D/g, '')] })).filter((x) => x.g && x.subject && x.what) };
    }
    if (!raw || !raw.blocks.length) raw = localStudyPlan(periods, catchUp);
    // place blocks inside their free period, one after another, leaving 10 min before class
    const fill = new Map();
    const blocks = raw.blocks.map((x) => {
      const start = fill.get(x.g) || x.g.from;
      const room = (x.g.to - 10 * MIN - start) / MIN;
      const minutes = Math.round(clamp(+x.minutes || 45, 15, Math.min(90, room)));
      if (room < 15) return null;
      fill.set(x.g, start + minutes * MIN);
      return { id: `${start}-${Math.random().toString(36).slice(2, 6)}`, from: start, to: start + minutes * MIN, beforeAt: x.g.to, before: x.g.name,
        subject: String(x.subject).slice(0, 40), what: String(x.what).slice(0, 80), status: 'todo' };
    }).filter(Boolean);
    plans[weekKey()] = { blocks: [...keep, ...blocks].sort((a, c) => a.from - c.from), note: raw.note, created: Date.now() };
    savePlans();
    b.disabled = false; $('#splanReplan').disabled = false;
    renderWeek();
    toast(replan ? 'Moved what you missed to later this week.' : 'Planned. Tap a block to change it or start it.');
  }

  function renderStudyPlan() {
    const plan = thisPlan(), blocks = plan ? plan.blocks : [];
    const total = Math.round(blocks.reduce((a, x) => a + (x.to - x.from) / MIN, 0));
    const done = blocks.filter((x) => x.status === 'done').length;
    const short = (m) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : `${m / 60} h`);
    $('#splanTitle').textContent = weekOffset === 0 ? 'This week\'s plan' : weekOffset === 1 ? 'Next week\'s plan' : 'Study plan';
    // first time: a clear button. After that: a small text link.
    $('#splanBtn').textContent = blocks.length ? 'Redo' : weekOffset ? 'Plan this week' : 'Plan my week';
    $('#splanBtn').className = blocks.length ? 'link-btn' : 'primary';
    $('#splanText').textContent = blocks.length
      ? `${fmtDur(total)} of study over ${blocks.length} block${blocks.length === 1 ? '' : 's'}${done ? `, ${done} done so far` : ''}.`
      : 'I\'ll fit study time into your free periods, with your nearest exams first.';
    const bySub = {};
    blocks.forEach((x) => { bySub[x.subject] = (bySub[x.subject] || 0) + (x.to - x.from) / MIN; });
    $('#splanSubjects').textContent = Object.entries(bySub).sort((a, b) => b[1] - a[1]).map(([sub, m]) => `${sub} ${short(Math.round(m))}`).join(', ');
    const note = plan && plan.note ? String(plan.note).trim() : '';
    $('#splanNote').textContent = note.length && note.length <= 90 ? note : '';
    $('#splanClear').hidden = !blocks.length;
    const missed = blocks.filter((x) => x.status === 'todo' && x.to < Date.now());
    $('#splanMissed').hidden = !missed.length || !studyPeriods().length;
    if (missed.length) {
      const subs = [...new Set(missed.map((x) => x.subject))].join(', ');
      $('#splanMissedText').textContent = `You missed ${missed.length === 1 ? 'a block' : `${missed.length} blocks`} (${subs}).`;
    }
    // week navigation
    const days = weekDays(weekOffset);
    $('#weekLabel').textContent = weekOffset === 0 ? 'This week' : weekOffset === 1 ? 'Next week' : `In ${weekOffset} weeks`;
    const f = (d) => d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    $('#weekRange').textContent = `${f(days[0])} – ${f(days[6])}`;
    $('#weekPrev').disabled = weekOffset === 0;
    $('#weekNext').disabled = weekOffset >= 4;
  }

  function useBlock(b) {
    if (b.to < Date.now()) { toast('That one\'s already passed. Tap Re-plan to move it later in the week.'); return; }
    if (!tasks.some((t) => t.toLowerCase() === b.what.toLowerCase())) { tasks.unshift(b.what); store('fp_tasks', tasks); }
    else { tasks = [b.what, ...tasks.filter((t) => t.toLowerCase() !== b.what.toLowerCase())]; store('fp_tasks', tasks); }
    useGap({ from: b.from, to: b.beforeAt, name: b.before }, b.id);
  }
  function markBlockDone(id) {
    for (const k of Object.keys(plans)) {
      const blk = plans[k].blocks.find((x) => x.id === id);
      if (blk) { blk.status = 'done'; savePlans(); return; }
    }
  }

  $('#splanBtn').addEventListener('click', () => makeStudyPlan(false));
  $('#splanReplan').addEventListener('click', () => makeStudyPlan(true));
  $('#splanClear').addEventListener('click', () => {
    if (!confirm('Clear the study plan for this week?')) return;
    delete plans[weekKey()]; savePlans(); renderWeek();
  });
  $('#weekPrev').addEventListener('click', () => { weekOffset = Math.max(0, weekOffset - 1); renderWeek(); });
  $('#weekNext').addEventListener('click', () => { weekOffset = Math.min(4, weekOffset + 1); renderWeek(); });

  async function readTimetable(file) {
    if (!file) return;
    if (!aiMode()) {
      $('#ttStatus').textContent = 'I need AI to read your timetable. Turn it on in Settings, or use the sample for now.';
      return;
    }
    $('#ttStatus').textContent = 'Reading your timetable, give me a few seconds…';
    try {
      const f = await readForAI(file);
      const j = await aiJSON(ttPrompt(), 'timetable reader', [f], 3000);
      if (!j) { $('#ttStatus').textContent = 'I couldn\'t read it this time. Try again, or use the sample for now.'; return; }
      const t = cleanTimetable(j);
      if (!t.classes.length) {
        $('#ttStatus').textContent = 'I couldn\'t find any classes in that. A clearer photo or a screenshot usually works better.';
        return;
      }
      timetable = t;
      store('fp_timetable', timetable);
      const n = (k, w) => `${k} ${w}${k === 1 ? '' : (w.endsWith('s') ? 'es' : 's')}`;
      $('#ttStatus').textContent = `Got it: ${n(t.classes.length, 'class')}${t.exams.length ? ` and ${n(t.exams.length, 'exam date')}` : ''}. Tap Edit if I got anything wrong.`;
      renderWeek();
    } catch (e) {
      $('#ttStatus').textContent = e.message;
    }
  }
  $('#ttFile').addEventListener('change', (e) => { readTimetable(e.target.files[0]); e.target.value = ''; });
  $('#ttFile2').addEventListener('change', async (e) => { $('#ttDlg').close(); await readTimetable(e.target.files[0]); e.target.value = ''; });
  $('#ttSample').addEventListener('click', () => { timetable = sampleTimetable(); store('fp_timetable', timetable); $('#ttStatus').textContent = ''; renderWeek(); });

  // ---------- edit timetable (add / change / delete classes and exams) ----------
  let ttEditing = null; // { kind: 'class' | 'exam', i } while changing an existing row
  const ttKind = () => document.querySelector('input[name="ttKind"]:checked').value;
  function setTtKind(kind) {
    document.querySelector(`input[name="ttKind"][value="${kind}"]`).checked = true;
    $('#ttClassFields').hidden = kind !== 'class';
    $('#ttExamFields').hidden = kind !== 'exam';
    $('#ttName').placeholder = kind === 'class' ? 'Machine Learning Lecture' : 'ML midterm';
    $('#ttFormTitle').textContent = `${ttEditing ? 'Change' : 'Add'} ${kind === 'class' ? 'a class' : 'an exam or deadline'}`;
  }
  document.querySelectorAll('input[name="ttKind"]').forEach((r) => r.addEventListener('change', () => setTtKind(ttKind())));
  function resetTtForm() {
    ttEditing = null;
    $('#ttName').value = ''; $('#ttFormErr').textContent = '';
    $('#ttFormSave').textContent = 'Add'; $('#ttFormCancel').hidden = true;
    setTtKind(ttKind());
  }
  function editTtRow(kind, i) {
    ttEditing = { kind, i };
    setTtKind(kind);
    if (kind === 'class') {
      const c = timetable.classes[i];
      $('#ttDay').value = c.day; $('#ttStart').value = c.start.padStart(5, '0'); $('#ttEnd').value = c.end.padStart(5, '0'); $('#ttName').value = c.name;
    } else {
      const e = timetable.exams[i];
      $('#ttDate').value = e.date; $('#ttName').value = e.name;
    }
    $('#ttFormSave').textContent = 'Save change'; $('#ttFormCancel').hidden = false;
    $('#ttName').focus();
  }
  function ttChanged() {
    timetable.sample = false;
    store('fp_timetable', timetable); renderTtList(); renderWeek();
  }
  function renderTtList() {
    const ul = $('#ttList');
    ul.innerHTML = '';
    const order = (c) => ((DAYS.indexOf(c.day) + 6) % 7) * 1440 + hm(c.start);
    const rows = [
      ...timetable.classes.map((c, i) => ({ kind: 'class', i, sort: order(c), text: `${c.day} ${c.start}–${c.end}`, name: c.name })),
      ...timetable.exams.map((e, i) => ({ kind: 'exam', i, sort: 1e7 + new Date(e.date).getTime() / 1e6, text: new Date(e.date + 'T00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }), name: `Exam: ${e.name}` }))
    ].sort((a, b) => a.sort - b.sort);
    if (!rows.length) ul.innerHTML = '<li class="muted small">Nothing here yet. Add your first class below.</li>';
    rows.forEach((r) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="mins" style="margin:0;min-width:7.5em"></span><span class="t"></span>';
      li.querySelector('.mins').textContent = r.text;
      li.querySelector('.t').textContent = r.name;
      const ed = document.createElement('button');
      ed.type = 'button'; ed.className = 'ghost x'; ed.innerHTML = ico('pencil');
      ed.setAttribute('aria-label', `Change ${r.name}`);
      ed.addEventListener('click', () => editTtRow(r.kind, r.i));
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'ghost x'; x.innerHTML = ico('x');
      x.setAttribute('aria-label', `Remove ${r.name}`);
      x.addEventListener('click', () => {
        (r.kind === 'class' ? timetable.classes : timetable.exams).splice(r.i, 1);
        resetTtForm(); ttChanged();
      });
      li.append(ed, x); ul.append(li);
    });
  }
  $('#ttForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const kind = ttKind(), name = $('#ttName').value.trim();
    if (!name) { $('#ttFormErr').textContent = 'Give it a name.'; return; }
    if (!timetable) timetable = { classes: [], exams: [] };
    if (kind === 'class') {
      const start = $('#ttStart').value, end = $('#ttEnd').value;
      if (!start || !end || hm(end) <= hm(start)) { $('#ttFormErr').textContent = 'The end time needs to be after the start time.'; return; }
      const row = { day: $('#ttDay').value, start, end, name: name.slice(0, 40) };
      if (ttEditing && ttEditing.kind === 'class') timetable.classes[ttEditing.i] = row;
      else { if (ttEditing) timetable.exams.splice(ttEditing.i, 1); timetable.classes.push(row); }
    } else {
      const date = $('#ttDate').value;
      if (!date) { $('#ttFormErr').textContent = 'Pick a date.'; return; }
      const row = { date, name: name.slice(0, 40) };
      if (ttEditing && ttEditing.kind === 'exam') timetable.exams[ttEditing.i] = row;
      else { if (ttEditing) timetable.classes.splice(ttEditing.i, 1); timetable.exams.push(row); }
    }
    resetTtForm(); ttChanged();
    $('#ttName').focus();
  });
  $('#ttFormCancel').addEventListener('click', resetTtForm);
  function openTtEditor() {
    if (!timetable) timetable = { classes: [], exams: [] };
    resetTtForm(); renderTtList(); $('#ttDlg').showModal();
  }
  $('#ttEditBtn').addEventListener('click', openTtEditor);
  $('#ttTypeBtn').addEventListener('click', openTtEditor);
  $('#ttDone').addEventListener('click', () => $('#ttDlg').close());
  $('#ttDlg').addEventListener('close', () => {
    if (timetable && !timetable.classes.length && !timetable.exams.length) { timetable = null; drop('fp_timetable'); }
    renderWeek();
  });
  $('#ttClear').addEventListener('click', () => {
    if (!confirm('Remove all your classes and exams?')) return;
    timetable = null; drop('fp_timetable'); $('#ttStatus').textContent = ''; $('#ttDlg').close(); renderWeek();
  });

  // ---------- edit study blocks / add one in free time ----------
  let blockEditing = null; // { block } for an existing block, or { gap } for new one in free time
  const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const toHHMM = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  function blockDialog(mode) {
    const isNew = mode === 'new';
    $('#bDelete').hidden = isNew; $('#bStartBtn').hidden = isNew; $('#bPlanNow').hidden = !isNew; $('#bCancel').hidden = !isNew;
    $('#bSave').textContent = isNew ? 'Add study block' : 'Save';
    $('#bSave').className = isNew ? 'primary grow' : '';
    $('#bErr').textContent = '';
    const dl = $('#subjectList'); dl.innerHTML = '';
    (timetable ? studySubjects() : []).forEach((sub) => { const o = document.createElement('option'); o.value = sub; dl.append(o); });
    $('#blockDlg').showModal();
  }
  function openBlock(x) {
    blockEditing = { block: x };
    $('#blockTitle').textContent = x.status === 'done' ? 'Study block (done)' : 'Study block';
    $('#blockWhen').textContent = `${new Date(x.from).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}, ${hhmm(x.from)}–${hhmm(x.to)}`;
    $('#bSubject').value = x.subject; $('#bWhat').value = x.what;
    $('#bStart').value = toHHMM(x.from); $('#bMins').value = Math.round((x.to - x.from) / MIN);
    blockDialog('edit');
    $('#bStartBtn').hidden = x.to < Date.now() || x.status === 'done';
  }
  function openFree(g) {
    blockEditing = { gap: g };
    const mins = Math.round((g.to - g.from) / MIN);
    $('#blockTitle').textContent = `${fmtDur(mins)} free`;
    $('#blockWhen').textContent = `${new Date(g.from).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}, ${hhmm(g.from)}–${hhmm(g.to)}, before ${g.name}. Plan it now, or add a study block here.`;
    $('#bSubject').value = timetable ? (studySubjects().find((sub) => examFor(sub)) || studySubjects()[0] || '') : '';
    $('#bWhat').value = '';
    $('#bStart').value = toHHMM(g.from); $('#bMins').value = Math.max(15, Math.min(60, Math.floor((mins - 10) / 5) * 5));
    blockDialog('new');
  }
  $('#blockForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const subject = $('#bSubject').value.trim(), what = $('#bWhat').value.trim() || 'Study';
    const mins = clamp(+$('#bMins').value || 0, 0, 240);
    if (!subject) { $('#bErr').textContent = 'Add a subject.'; return; }
    if (mins < 15) { $('#bErr').textContent = 'Make it at least 15 minutes.'; return; }
    const base = dayStart(blockEditing.block ? blockEditing.block.from : blockEditing.gap.from);
    const from = base + hm($('#bStart').value || '00:00') * MIN, to = from + mins * MIN;
    const day = new Date(base);
    const clash = timetable && timetable.classes.find((c) => c.day === DAYS[day.getDay()] && base + hm(c.start) * MIN < to && base + hm(c.end) * MIN > from);
    if (clash) { $('#bErr').textContent = `That overlaps with ${clash.name} (${clash.start}–${clash.end}).`; return; }
    // the next class after the block is what you "leave" for
    const next = timetable ? timetable.classes.filter((c) => c.day === DAYS[day.getDay()] && base + hm(c.start) * MIN >= to).sort((a, b) => hm(a.start) - hm(b.start))[0] : null;
    const fields = { from, to, subject: subject.slice(0, 40), what: what.slice(0, 80),
      before: next ? next.name : 'the end of this block', beforeAt: next ? base + hm(next.start) * MIN : to };
    const mon = new Date(base); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    const key = ymd(mon); // plans are stored per Monday-to-Sunday week
    if (blockEditing.block) Object.assign(blockEditing.block, fields);
    else {
      plans[key] = plans[key] || { blocks: [], note: '', created: Date.now() };
      plans[key].blocks.push({ id: `${from}-${Math.random().toString(36).slice(2, 6)}`, status: 'todo', ...fields });
    }
    Object.values(plans).forEach((p) => p.blocks.sort((a, b) => a.from - b.from));
    savePlans();
    $('#blockDlg').close(); renderWeek();
    toast(blockEditing.block ? 'Saved.' : 'Study block added.');
  });
  $('#bDelete').addEventListener('click', () => {
    const id = blockEditing.block.id;
    Object.values(plans).forEach((p) => { p.blocks = p.blocks.filter((x) => x.id !== id); });
    savePlans(); $('#blockDlg').close(); renderWeek();
    toast('Study block deleted.');
  });
  $('#bStartBtn').addEventListener('click', () => { const x = blockEditing.block; $('#blockDlg').close(); useBlock(x); });
  $('#bPlanNow').addEventListener('click', () => { const g = blockEditing.gap; $('#blockDlg').close(); useGap(g); });
  $('#bCancel').addEventListener('click', () => $('#blockDlg').close());

  // ---------- notes → flashcards (with a saved list of decks) ----------
  let decks = load('fp_decks', null);
  if (!decks) { // move a deck from the older version into the list
    const old = load('fp_deck', null);
    decks = old && old.cards ? [{ id: Date.now(), title: 'My cards', created: Date.now(), cards: old.cards }] : [];
    store('fp_decks', decks); drop('fp_deck');
  }
  const saveDecks = () => store('fp_decks', decks);
  let deck = null, cardIdx = 0, gotIt = 0, notesFile = null, cardOrder = [];
  const cardsPrompt = (text) =>
    `Make 6 flashcards for active recall from these study notes${text ? '' : ' (in the attached file)'}. ` +
    `Questions test understanding, not trivia. Answers are under 25 words. Use the same language as the notes. ` +
    `Also give the deck a short title (under 6 words) naming the topic.` +
    (text ? `\nNotes:\n<<<\n${text.slice(0, 12000)}\n>>>` : '') +
    `\nRespond only with JSON, no other text: {"title":string,"cards":[{"q":string,"a":string}]}`;
  // No AI: turn sentences into fill-in-the-blank cards.
  function localCards(text) {
    return text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 6)
      .slice(0, 8).map((sent) => {
        const w = sent.replace(/[^\w\s-]/g, '').split(/\s+/).filter((x) => x.length > 3).sort((a, b) => b.length - a.length)[0];
        return w ? { q: sent.replace(new RegExp(`\\b${w}\\b`), '_____'), a: w } : null;
      }).filter(Boolean).slice(0, 6);
  }
  function cardsView(which) {
    $('#cardsHome').hidden = which !== 'home';
    $('#cardsPlay').hidden = which !== 'play';
    $('#cardsEnd').hidden = which !== 'end';
  }
  function renderDecks() {
    const ul = $('#deckList');
    ul.innerHTML = '';
    if (!decks.length) { ul.innerHTML = '<li class="muted small">No decks yet. Your cards will be saved here.</li>'; return; }
    [...decks].sort((a, b) => b.created - a.created).forEach((d) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="t"><b class="d-title"></b><span class="tag"></span></span>';
      li.querySelector('.d-title').textContent = d.title;
      const made = new Date(d.created).toLocaleDateString([], { day: 'numeric', month: 'short' });
      li.querySelector('.tag').textContent = `${d.cards.length} cards, made ${made}` +
        (d.last ? `. Last score ${d.last.got}/${d.last.total}` : '. Not practised yet');
      const go = document.createElement('button');
      go.type = 'button'; go.textContent = 'Practise';
      go.addEventListener('click', () => startDeck(d));
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'ghost x'; x.innerHTML = ico('trash');
      x.setAttribute('aria-label', `Delete ${d.title}`);
      x.addEventListener('click', () => {
        if (!confirm(`Delete "${d.title}"?`)) return;
        decks = decks.filter((y) => y.id !== d.id); saveDecks(); renderDecks();
      });
      li.append(go, x); ul.append(li);
    });
  }
  function openCards() {
    notesFile = null; $('#notesFileName').textContent = ''; $('#cardsStatus').textContent = '';
    renderDecks();
    cardsView('home');
  }
  function showCard() {
    const c = deck.cards[cardOrder[cardIdx]];
    $('#cardCount').textContent = `${cardIdx + 1} of ${cardOrder.length}`;
    $('#cardQ').textContent = c.q;
    $('#cardA').textContent = c.a;
    $('#cardA').hidden = true; $('#cardShow').hidden = false; $('#cardRate').hidden = true;
    $('#cardShow').focus();
  }
  function startDeck(d) {
    deck = d || deck;
    // the ones you missed last time come first
    cardOrder = deck.cards.map((_, i) => i).sort((a, b) => (deck.cards[b].missed ? 1 : 0) - (deck.cards[a].missed ? 1 : 0));
    cardIdx = 0; gotIt = 0;
    $('#deckTitle').textContent = deck.title;
    cardsView('play'); showCard();
  }
  function rate(ok) {
    deck.cards[cardOrder[cardIdx]].missed = !ok;
    if (ok) gotIt++;
    if (++cardIdx < cardOrder.length) { saveDecks(); return showCard(); }
    deck.last = { got: gotIt, total: cardOrder.length, at: Date.now() };
    saveDecks();
    const all = gotIt === cardOrder.length;
    $('#cardsScore').textContent = all ? `All ${gotIt} right!` : `${gotIt} out of ${cardOrder.length}`;
    $('#cardsScoreNote').textContent = all ? 'You know this one. Try it again in a few days so it sticks.'
      : 'The ones you missed will come up first next time.';
    cardsView('end');
    $('#cardsAgain').focus();
  }
  $('#notesFile').addEventListener('change', (e) => {
    notesFile = e.target.files[0] || null;
    $('#notesFileName').textContent = notesFile ? notesFile.name : '';
  });
  $('#cardsMake').addEventListener('click', async () => {
    const text = $('#notesText').value.trim();
    if (!text && !notesFile) { $('#cardsStatus').textContent = 'Paste some notes or upload a photo of them first.'; return; }
    const b = $('#cardsMake');
    b.disabled = true; b.textContent = 'Making cards…';
    $('#cardsStatus').textContent = '';
    let cards = null, title = '';
    try {
      const files = notesFile ? [await readForAI(notesFile)] : [];
      if (files.length && !aiMode()) {
        $('#cardsStatus').textContent = 'I need AI to read photos and PDFs. Turn it on in Settings, or paste the text instead.';
      } else {
        const j = await aiJSON(cardsPrompt(text), 'flashcard maker', files, 2500);
        cards = ((j && j.cards) || []).filter((c) => c && c.q && c.a).map((c) => ({ q: String(c.q), a: String(c.a) }));
        title = j && j.title ? String(j.title).slice(0, 50) : '';
      }
    } catch (e) { $('#cardsStatus').textContent = e.message; }
    if ((!cards || !cards.length) && text) cards = localCards(text);
    b.disabled = false; b.textContent = 'Make cards';
    if (!cards || !cards.length) {
      if (!$('#cardsStatus').textContent) $('#cardsStatus').textContent = 'I couldn\'t make cards from that. Try a longer bit of notes.';
      return;
    }
    if (!title) title = notesFile ? notesFile.name.replace(/\.[^.]+$/, '') : text.split(/\s+/).slice(0, 5).join(' ') + '…';
    const d = { id: Date.now(), title, created: Date.now(), cards };
    decks.push(d); saveDecks();
    $('#notesText').value = ''; notesFile = null; $('#notesFileName').textContent = '';
    startDeck(d);
  });
  $('#cardShow').addEventListener('click', () => {
    $('#cardA').hidden = false; $('#cardShow').hidden = true; $('#cardRate').hidden = false; $('#cardGotIt').focus();
  });
  $('#cardGotIt').addEventListener('click', () => rate(true));
  $('#cardNotYet').addEventListener('click', () => rate(false));
  $('#cardsAgain').addEventListener('click', () => startDeck());
  $('#cardsHomeBtn').addEventListener('click', openCards);
  $('#cardsQuit').addEventListener('click', () => { saveDecks(); openCards(); });

  // ---------- your pace + burnout check ----------
  let history = load('fp_history', { steps: [], sessions: [] });
  const saveHistory = () => store('fp_history', history);
  // How much longer (or shorter) you usually take than estimated, from your last 20 finished steps.
  function pace() {
    const r = history.steps.slice(-20).map((x) => x.actual / x.est).sort((a, b) => a - b);
    if (r.length < 3) return 1;
    return Math.round(clamp(r[Math.floor(r.length / 2)], 0.6, 1.8) * 10) / 10;
  }
  function recordStep(step) {
    if (!S.stepStartedAt) return;
    const actual = ((S.pausedAt || Date.now()) - S.stepStartedAt - (S.pausedTotal || 0)) / MIN;
    const est = step.planned || step.minutes;
    if (actual < 0.5 || actual > est * 3) return; // tapped straight through, or walked away
    history.steps.push({ est, actual: Math.round(actual * 10) / 10, t: Date.now() });
    history.steps = history.steps.slice(-60);
    saveHistory();
  }
  function recordSession() {
    const done = S.steps.filter((x) => x.status === 'done');
    history.sessions.push({
      t: Date.now(), hour: new Date().getHours(),
      done: done.length, skipped: S.steps.filter((x) => x.status === 'skipped').length, splits: S.splits || 0,
      focusMin: Math.round(done.reduce((a, x) => a + x.minutes, 0))
    });
    history.sessions = history.sessions.slice(-30);
    saveHistory();
  }
  function burnoutSigns() {
    const recent = history.sessions.slice(-3);
    const signs = [];
    const avoid = recent.reduce((a, x) => a + x.skipped + x.splits, 0), did = recent.reduce((a, x) => a + x.done, 0);
    if (recent.length >= 2 && avoid >= 4 && avoid >= did * 1.5) signs.push('you\'ve been skipping or splitting most steps lately');
    const late = history.sessions.filter((x) => Date.now() - x.t < 3 * 864e5 && (x.hour >= 23 || x.hour < 4)).length;
    if (late >= 2) signs.push('you\'ve studied past 11pm a few times this week');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const mins = history.sessions.filter((x) => x.t >= today.getTime()).reduce((a, x) => a + x.focusMin, 0);
    if (mins >= 180) signs.push(`you've already done ${fmtDur(mins)} of focused work today`);
    return signs;
  }
  function renderBurnout() {
    const signs = burnoutSigns();
    const snoozed = load('fp_burnout_ok', 0) > Date.now() - 6 * 3600e3;
    $('#burnout').hidden = !signs.length || snoozed;
    if (signs.length) $('#burnoutMsg').textContent = `Hey, ${signs.join(', and ')}. Want to go easier next time? A real break counts too.`;
  }
  $('#burnoutLight').addEventListener('click', () => {
    document.querySelector('input[name="energy"][value="low"]').checked = true;
    store('fp_burnout_ok', Date.now()); $('#burnout').hidden = true;
    toast('Okay, your next plan will have smaller steps.');
  });
  $('#burnoutOk').addEventListener('click', () => { store('fp_burnout_ok', Date.now()); $('#burnout').hidden = true; });


  // ---------- tabs ----------
  const TABS = ['week', 'plan', 'cards', 'you'];
  function switchTab(name) {
    TABS.forEach((t) => {
      const on = t === name;
      $(`#tab-${t}`).hidden = !on;
      const b = $(`#tabbtn-${t}`);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    store('fp_tab', name);
    if (name === 'week') { renderWeek(); renderBurnout(); }
    if (name === 'cards' && $('#cardsPlay').hidden && $('#cardsEnd').hidden) openCards();
    if (name === 'you') renderYou();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tab').forEach((b, i, all) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const next = all[(i + d + all.length) % all.length];
      next.focus(); switchTab(next.dataset.tab);
    });
  });
  $('#skipTtBtn').addEventListener('click', () => { switchTab('plan'); });

  // ---------- Progress page ----------
  function renderYou() {
    const week = history.sessions.filter((x) => Date.now() - x.t < 7 * 864e5);
    const steps = week.reduce((a, x) => a + x.done, 0), mins = week.reduce((a, x) => a + x.focusMin, 0);
    $('#weekText').textContent = week.length
      ? `You got ${steps} step${steps === 1 ? '' : 's'} done and focused for ${fmtDur(mins)} in ${week.length} session${week.length === 1 ? '' : 's'}.`
      : 'Nothing yet this week. Plan a free period and it\'ll show up here.';
    const ul = $('#sessionList');
    ul.innerHTML = '';
    week.slice(-5).reverse().forEach((x) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="mins" style="margin:0;min-width:7.5em"></span><span class="t"></span>';
      li.querySelector('.mins').textContent = new Date(x.t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      const bits = [`${x.done} done`];
      if (x.skipped) bits.push(`${x.skipped} skipped`);
      if (x.splits) bits.push(`split ${x.splits} time${x.splits === 1 ? '' : 's'}`);
      li.querySelector('.t').textContent = bits.join(', ');
      ul.append(li);
    });

    const p = pace(), n = history.steps.slice(-20).length;
    $('#paceText').textContent = n < 3
      ? `I'm still learning this. Finish ${3 - n} more step${3 - n === 1 ? '' : 's'} and I'll know if you need more or less time than I plan.`
      : p >= 1.2 ? `You usually need about ${p}× the time I plan, and that's totally normal. So now I give you more time for each step.`
      : p <= 0.8 ? `You usually finish faster than I plan (about ${p}×), so I make your steps a bit shorter now.`
      : 'My time guesses are about right for you, so I\'m keeping them as they are.';

    const signs = burnoutSigns();
    $('#burnoutStatus').textContent = signs.length
      ? `${cap(signs.join(', and '))}. Maybe take a proper break, or pick "Tired" next time so your steps are smaller.`
      : 'You\'re doing fine. Nothing here says you\'re overdoing it.';
    $('#burnoutStatus').className = signs.length ? 'warn-text' : '';
    updateDots();
  }
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  function updateDots() {
    $('#youDot').hidden = !burnoutSigns().length;
    $('#planDot').hidden = !(S && S.running);
  }
  $('#demoBtn').addEventListener('click', () => {
    const h = (hrs) => Date.now() - hrs * 3600e3;
    history = {
      steps: [[10, 14], [5, 8], [8, 11], [3, 5], [12, 16], [6, 9]].map(([est, actual], i) => ({ est, actual, t: h(30 - i) })),
      sessions: [
        { t: h(50), hour: 15, done: 4, skipped: 0, splits: 1, focusMin: 32 },
        { t: h(26), hour: 23, done: 1, skipped: 3, splits: 2, focusMin: 6 },
        { t: h(3), hour: 23, done: 0, skipped: 2, splits: 2, focusMin: 0 }
      ]
    };
    saveHistory(); drop('fp_burnout_ok');
    if (!timetable) { timetable = sampleTimetable(); store('fp_timetable', timetable); }
    renderYou();
    toast('Example data added. Tap Reset to clear it.');
  });
  $('#clearHistBtn').addEventListener('click', () => {
    if (!confirm('Clear your progress? This removes your pace and past sessions.')) return;
    history = { steps: [], sessions: [] }; saveHistory(); renderYou();
  });

  // ---------- setup: task list ----------
  function renderTasks() {
    const ul = $('#taskList');
    ul.innerHTML = '';
    $('#clearTasksBtn').hidden = tasks.length === 0;
    tasks.forEach((t, i) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="num"></span><span class="t"></span>';
      li.querySelector('.num').textContent = i + 1;
      li.querySelector('.t').textContent = t;
      if (i > 0) {
        const up = document.createElement('button');
        up.type = 'button'; up.className = 'ghost x'; up.innerHTML = ico('up');
        up.setAttribute('aria-label', `Move up: ${t}`);
        up.addEventListener('click', () => { [tasks[i - 1], tasks[i]] = [tasks[i], tasks[i - 1]]; store('fp_tasks', tasks); renderTasks(); });
        li.append(up);
      }
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'ghost x'; x.innerHTML = ico('x');
      x.setAttribute('aria-label', `Remove task: ${t}`);
      x.addEventListener('click', () => { tasks.splice(i, 1); store('fp_tasks', tasks); renderTasks(); });
      li.append(x);
      ul.append(li);
    });
  }
  function addTask() {
    const v = $('#taskInput').value.trim();
    if (!v) return false;
    tasks.push(v.slice(0, 120));
    store('fp_tasks', tasks);
    $('#taskInput').value = '';
    renderTasks();
    announce(`Added: ${v}. ${tasks.length} tasks.`);
    return true;
  }
  $('#addTaskBtn').addEventListener('click', () => { addTask(); $('#taskInput').focus(); });
  $('#clearTasksBtn').addEventListener('click', () => {
    if (!confirm(`Remove all ${tasks.length} tasks? Saved unfinished steps will be cleared too.`)) return;
    tasks = [];
    store('fp_tasks', tasks);
    drop('fp_later');
    initSetup();
    announce('All tasks cleared.');
    $('#taskInput').focus();
  });
  $('#taskInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTask(); }
  });

  // ---------- setup ----------
  function initSetup() {
    renderTasks();
    renderWeek();
    renderBurnout();
    const later = load('fp_later', null);
    // tasks you didn't finish last time: offer them, don't force them
    const leftover = later && later.steps ? [...new Set(later.steps.map((x) => x.task || later.task).filter(Boolean))]
      .filter((t) => !tasks.some((y) => y.toLowerCase() === String(t).toLowerCase())) : [];
    $('#laterBanner').hidden = !leftover.length;
    $('#laterTask').textContent = leftover.join(', ');
    $('#useLater').checked = false;
    $('#taskWrap').hidden = false;
    if (!$('#eventTime').value) {
      $('#eventTime').value = toLocalInput(new Date(Date.now() + 60 * MIN));
      $('#eventTime').min = toLocalInput(new Date());
    }
    $('#leavePill').hidden = true;
    document.title = 'FreePeriod';
  }
  $('#useLater').addEventListener('change', (e) => ($('#taskWrap').hidden = e.target.checked));
  $('#laterKeep').addEventListener('click', () => {
    const later = load('fp_later', null);
    const names = later && later.steps ? [...new Set(later.steps.map((x) => x.task || later.task).filter(Boolean))] : [];
    names.forEach((t) => { if (!tasks.some((y) => y.toLowerCase() === String(t).toLowerCase())) tasks.push(String(t)); });
    store('fp_tasks', tasks); drop('fp_later');
    $('#laterBanner').hidden = true; renderTasks();
  });
  $('#laterDrop').addEventListener('click', () => { drop('fp_later'); $('#laterBanner').hidden = true; });

  $('#setupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    ensureAudio(); // unlock sound with this click
    $('#setupError').textContent = '';

    const eventAt = new Date($('#eventTime').value); // datetime-local is read as local time
    if (Number.isNaN(eventAt.getTime())) return ($('#setupError').textContent = 'Add the date and time your next thing starts.');
    if (eventAt.getTime() <= Date.now()) return ($('#setupError').textContent = 'That time has already passed. Pick a later date or time.');

    const buffer = clamp(+$('#buffer').value || 0, 0, 180);
    const leaveAt = eventAt.getTime() - buffer * MIN;
    const useLater = $('#useLater').checked;
    const later = load('fp_later', null);
    if (!useLater) addTask(); // include anything typed but not added yet
    if (!useLater && !tasks.length) return ($('#setupError').textContent = 'Add at least one task you\'re avoiding. A few words is enough.');
    const energy = document.querySelector('input[name="energy"]:checked').value;

    S = {
      eventName: $('#eventName').value.trim() || 'your next thing',
      eventAt: eventAt.getTime(), leaveAt, tasks: [...tasks], energy,
      // planning a free period from the calendar that hasn't started yet
      periodFrom: pickedGap && pickedGap.to === eventAt.getTime() ? pickedGap.from : 0,
      blockId: pickedGap && pickedGap.to === eventAt.getTime() ? pickedBlock : null,
      steps: [], idx: 0, running: false, warned: false, source: ''
    };

    if (useLater) {
      S.steps = later.steps.map((s) => ({ ...s, task: s.task || later.task || 'Saved task', status: 'todo' }));
      S.tasks = [...new Set(S.steps.map((s) => s.task))];
      S.source = 'Your saved steps from last time.';
      drop('fp_later');
    } else {
      await generate();
    }
    saveState();
    renderPlan();
    show('plan');
  });

  async function generate() {
    const btns = [$('#planBtn'), $('#regenBtn')];
    btns.forEach((b) => (b.disabled = true));
    $('#planBtn').textContent = 'Planning…';
    const gap = clamp(windowMins(), 1, 90); // plan one focused session, even if the event is days away
    const ordered = examFirst(S.tasks);
    S.tasks = ordered;
    const p = pace();
    let ai = await aiSteps(planPrompt(ordered, Math.round(gap / p), S.energy));
    if (ai) ai = ai.map((s) => ({ ...s, task: ordered[s.task] ?? ordered[0] }));
    // size every step to how fast you actually work
    const scaled = (list) => list.map((s) => ({ ...s, planned: s.minutes, minutes: Math.max(1, Math.round(s.minutes * p)) }));
    const steps = ai ? scaled(ai) : pack(scaled(localPlan(ordered, S.energy)), gap);
    S.steps = steps.map((s) => ({ ...s, status: 'todo' }));
    S.splits = 0;
    const ex = upcomingExams()[0];
    S.source = (ai ? 'Steps made with AI.' : 'Basic steps. Turn on AI in Settings for steps made for your exact task.') +
      (p >= 1.2 ? ' I gave you extra time per step, since you usually need it.' : p <= 0.8 ? ' Steps are a bit shorter, since you usually work fast.' : '') +
      (ex && ex.days <= 30 ? ` ${ex.name} is ${inWords(ex.days)}, so that comes first.` : '');
    btns.forEach((b) => (b.disabled = false));
    $('#planBtn').textContent = 'Make my plan';
  }

  // ---------- plan ----------
  // The planning window starts now, or later if you picked a free period that hasn't started yet.
  const windowStart = () => Math.max(Date.now(), S.periodFrom || 0);
  const windowMins = () => Math.floor((S.leaveAt - windowStart()) / MIN);
  const isFuture = () => (S.periodFrom || 0) > Date.now() + 5 * MIN;
  function renderPlan() {
    const gap = windowMins();
    $('#planSource').textContent = S.source;
    const list = $('#stepList');
    list.innerHTML = '';

    if (gap < 2) {
      $('#planTitle').textContent = 'No time for this one.';
      $('#planSub').textContent = `You need to leave for ${S.eventName} at ${fmtTime(S.leaveAt)}, so start getting ready. I've saved your steps for next time.`;
      store('fp_later', { steps: S.steps.map(({ text, minutes, task }) => ({ text, minutes, task })) });
      $('#startBtn').hidden = true; $('#regenBtn').hidden = true;
      return;
    }
    $('#startBtn').hidden = false; $('#regenBtn').hidden = false;

    // first step must fit
    if (S.steps[0] && S.steps[0].minutes > gap) S.steps[0].minutes = Math.max(1, gap - 1);

    let acc = 0, fit = 0, shownDivider = false;
    S.steps.forEach((s, i) => {
      acc += s.minutes;
      const fits = acc <= gap;
      if (fits) fit++;
      if (!fits && !shownDivider) {
        const d = document.createElement('li');
        d.className = 'divider'; d.style.border = '0';
        d.textContent = 'For another time (won\'t fit before you leave):';
        list.append(d); shownDivider = true;
      }
      const li = document.createElement('li');
      if (!fits) li.classList.add('later');
      li.innerHTML = '<span class="num"></span><span class="t"></span><span class="mins"></span>';
      li.querySelector('.num').textContent = i + 1;
      li.querySelector('.t').textContent = s.text;
      if (S.tasks.length > 1 && s.task) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = s.task;
        li.querySelector('.t').append(tag);
      }
      li.querySelector('.mins').textContent = `${s.minutes} min`;
      if (S.steps.length > 1) {
        const x = document.createElement('button');
        x.className = 'ghost x'; x.innerHTML = ico('x');
        x.setAttribute('aria-label', `Remove step: ${s.text}`);
        x.addEventListener('click', () => { S.steps.splice(i, 1); saveState(); renderPlan(); });
        li.append(x);
      }
      list.append(li);
    });

    S.fit = Math.max(1, fit);
    const steps = `${fit} step${fit === 1 ? '' : 's'}`;
    if (isFuture()) {
      $('#planTitle').textContent = `${fmtDur(gap)} free from ${fmtTime(S.periodFrom)}.`;
      $('#planSub').textContent = `${steps} fit before you leave for ${S.eventName} at ${hhmm(S.leaveAt)}. Your plan is saved, so open FreePeriod then. Or start early if you want.`;
    } else {
      $('#planTitle').textContent = `You've got ${fmtDur(gap)}.`;
      $('#planSub').textContent = `${steps} fit before you leave for ${S.eventName} at ${fmtTime(S.leaveAt)}. I'll ring ${settings.warn} min before.`;
    }
    $('#startBtn').textContent = isFuture() ? 'Start early' : 'Start';
  }

  $('#backBtn').addEventListener('click', () => { S = null; drop('fp_state'); initSetup(); show('setup'); });
  $('#regenBtn').addEventListener('click', async () => { await generate(); saveState(); renderPlan(); });
  $('#startBtn').addEventListener('click', async () => {
    ensureAudio();
    try { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch {}
    S.running = true; S.warned = false; S.idx = 0;
    // The disc's full circle = time from now until you leave (between 5 min and 2 h).
    // Full circle = time until you leave, or just this plan's length if leaving is hours away.
    const planMs = S.steps.slice(0, S.fit || S.steps.length).reduce((a, x) => a + x.minutes * MIN, 0);
    S.faceMs = clamp(Math.min(S.leaveAt - Date.now(), Math.max(planMs, 15 * MIN)), 5 * MIN, 120 * MIN);
    startStep();
    updateDots();
    show('focus');
  });

  // ---------- focus ----------
  function startStep() {
    S.stepStartedAt = Date.now(); S.pausedTotal = 0; S.pausedAt = null; S.stepChimed = false;
    saveState();
    renderFocus();
  }
  function renderFocus() {
    const step = S.steps[S.idx];
    const todo = S.steps.filter((s) => s.status === 'todo').length;
    const doneN = S.steps.filter((s) => s.status === 'done').length;
    $('#stepText').textContent = step.text;
    const goal = Math.max(S.fit || 1, doneN + 1); // count only what fits this window, not every saved step
    $('#stepMeta').textContent = `Step ${doneN + 1} of ${goal}, about ${step.minutes} min`;
    $('#partOf').textContent = `Part of: ${step.task || ''}`;
    $('#progressBar').style.width = `${Math.min(100, (doneN / goal) * 100)}%`;
    $('#pauseBtn').innerHTML = S.pausedAt ? `${ico('play')}Resume` : `${ico('pause')}Pause`;
    $('#stepHint').textContent = '';
    $('#stepText').focus();
    announce(`Step ${S.idx + 1}: ${step.text}. About ${step.minutes} minutes.`);
    tick();
    if (!todo) finish('all');
  }
  function nextStep(status) {
    if (status === 'done') recordStep(S.steps[S.idx]);
    S.steps[S.idx].status = status;
    const n = S.steps.findIndex((s, i) => i > S.idx && s.status === 'todo');
    if (n === -1) return finish('all');
    S.idx = n;
    if (status === 'done') chime();
    startStep();
  }
  $('#doneBtn').addEventListener('click', () => nextStep('done'));
  $('#skipBtn').addEventListener('click', () => nextStep('skipped'));
  $('#endBtn').addEventListener('click', () => finish('early'));
  $('#pauseBtn').addEventListener('click', togglePause);
  $('#readBtn').addEventListener('click', readStep);
  $('#splitBtn').addEventListener('click', async () => {
    const b = $('#splitBtn');
    b.disabled = true; b.textContent = 'Splitting…';
    const step = S.steps[S.idx];
    const sub = (await aiSteps(splitPrompt(step))) || localSplit(step);
    S.steps.splice(S.idx, 1, ...sub.map((s) => ({ ...s, task: step.task, status: 'todo' })));
    S.splits = (S.splits || 0) + 1;
    b.disabled = false; b.innerHTML = `${ico('split')}Too hard: split smaller`;
    toast('Split it up. Just do the first bit.');
    startStep();
  });

  function togglePause() {
    if (S.pausedAt) { S.pausedTotal += Date.now() - S.pausedAt; S.pausedAt = null; }
    else S.pausedAt = Date.now();
    saveState(); renderFocus();
  }
  function readStep() {
    try {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(`${S.steps[S.idx].text}. You leave at ${fmtTime(S.leaveAt)}.`));
    } catch {}
  }

  document.addEventListener('keydown', (e) => {
    if ($('#focus').hidden || $('#tab-plan').hidden || e.target.matches('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'd') $('#doneBtn').click();
    else if (k === 's') $('#splitBtn').click();
    else if (k === 'k') $('#skipBtn').click();
    else if (k === 'p') togglePause();
    else if (k === 'r') readStep();
  });

  // ---------- finish ----------
  function finish(reason) {
    stopAlarmSound();
    recordSession();
    if (S.blockId && S.steps.some((x) => x.status === 'done')) markBlockDone(S.blockId);
    $('#alarm').hidden = true;
    const done = S.steps.filter((s) => s.status === 'done');
    const left = S.steps.filter((s) => s.status === 'todo');
    if (left.length) store('fp_later', { steps: left.map(({ text, minutes, task }) => ({ text, minutes, task })) });
    else drop('fp_later');

    const titles = {
      all: 'All done!',
      leave: `Off you go to ${S.eventName}!`,
      early: 'Good stop.'
    };
    $('#doneTitle').textContent = titles[reason];
    $('#doneMsg').textContent = done.length
      ? `You got ${done.length} step${done.length === 1 ? '' : 's'} done in time that usually just disappears.` +
        (left.length ? ` I saved the other ${left.length} for next time.` : '')
      : (left.length ? 'Starting is the hardest part. I saved your steps for next time.' : '');
    const list = $('#doneList');
    list.innerHTML = '';
    done.forEach((s) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="num">${ico('check')}</span><span class="t"></span>`;
      li.querySelector('.t').textContent = s.text;
      list.append(li);
    });
    S = null; drop('fp_state');
    $('#leavePill').hidden = true;
    document.title = 'FreePeriod';
    show('done');
    updateDots();
  }
  $('#againBtn').addEventListener('click', () => { initSetup(); show('setup'); });

  // ---------- alarm ----------
  function leaveAlarm() {
    $('#alarmSub').textContent = `Leave now for ${S.eventName} (starts ${fmtTime(S.eventAt)}).`;
    $('#alarm').hidden = false;
    $('#goingBtn').focus();
    startAlarmSound();
    notify('Time to go!', `Leave now for ${S.eventName}.`);
  }
  $('#goingBtn').addEventListener('click', () => finish('leave'));

  // ---------- time disc (Time Timer style) ----------
  // Top (12 o'clock) = when you leave. The coloured pie = time left, and it shrinks back
  // toward the top as time passes. Slices = this step, then the next steps, then spare time.
  const C = 100, R_OUT = 96, R_IN = 60;
  function polar(a, r) {
    const rad = ((a - 90) * Math.PI) / 180;
    return [(C + r * Math.cos(rad)).toFixed(2), (C + r * Math.sin(rad)).toFixed(2)];
  }
  function seg(a0, a1, ro, ri) {
    if (a1 - a0 >= 359.9) a1 = a0 + 359.9;
    const big = a1 - a0 > 180 ? 1 : 0;
    const [x0, y0] = polar(a0, ro), [x1, y1] = polar(a1, ro), [x2, y2] = polar(a1, ri), [x3, y3] = polar(a0, ri);
    return `M${x0} ${y0}A${ro} ${ro} 0 ${big} 1 ${x1} ${y1}L${x2} ${y2}A${ri} ${ri} 0 ${big} 0 ${x3} ${y3}Z`;
  }
  function renderDisc(now, stepRemMs) {
    const face = S.faceMs || clamp(S.leaveAt - now, 5 * MIN, 120 * MIN);
    const leftMs = Math.max(0, S.leaveAt - now);
    const leftDeg = Math.min(1, leftMs / face) * 360;
    const degOf = (ms) => (ms / face) * 360;
    let out = `<circle class="d-track" cx="${C}" cy="${C}" r="${R_OUT}"/>`;

    // Steps placed from "now" (edge of the pie) back toward "leave" (top).
    const order = [S.idx, ...S.steps.map((_, i) => i).filter((i) => i > S.idx && S.steps[i].status === 'todo')];
    let a = leftDeg;
    order.forEach((i, k) => {
      if (a <= 0) return;
      const ms = k === 0 ? Math.max(0, stepRemMs) : S.steps[i].minutes * MIN;
      const a0 = Math.max(0, a - degOf(ms));
      if (a - a0 > 0.3) out += `<path class="d-sep ${k === 0 ? 'd-cur' : k % 2 ? 'd-n1' : 'd-n2'}" d="${seg(a0, a, R_OUT, R_IN)}"/>`;
      a = a0;
    });
    if (a > 0.3) out += `<path class="d-sep d-free" d="${seg(0, a, R_OUT, R_IN)}"/>`;

    for (let t = 0; t < 12; t++) {
      const [x0, y0] = polar(t * 30, R_IN - 4), [x1, y1] = polar(t * 30, R_IN - (t % 3 ? 8 : 12));
      out += `<line class="d-tick" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`;
    }
    out += `<circle class="d-hole" cx="${C}" cy="${C}" r="${R_IN - 14}"/>`;
    out += `<line class="d-leave" x1="${C}" y1="${C - R_IN + 2}" x2="${C}" y2="${C - R_OUT - 6}"/>`;
    const far = leftMs > face * 1.05; // leaving is further away than this circle shows
    out += `<text class="d-leave-label" x="${C}" y="-11" text-anchor="middle">${far ? 'END OF PLAN' : `LEAVE ${fmtTime(S.leaveAt).toUpperCase()}`}</text>`;

    const disc = $('#disc');
    disc.innerHTML = out;
    disc.classList.toggle('warn', leftMs <= settings.warn * MIN);
    disc.classList.toggle('over', stepRemMs < 0);
    const lm = Math.ceil(leftMs / MIN);
    $('#leaveIn').textContent = leftMs <= 0 ? 'Time to leave' : lm > 180 ? `Leave ${fmtTime(S.leaveAt)}` : `${fmtDur(lm)} until you leave`;
  }

  // ---------- clock (Web Worker keeps ticking in background tabs) ----------
  let lastAnnouncedMin = null;
  function tick() {
    if (!S || !S.running) return;
    const now = Date.now();
    const leftMs = S.leaveAt - now;
    const leftMin = Math.max(0, Math.ceil(leftMs / MIN));

    // leave banner + header pill
    const warnZone = leftMs <= settings.warn * MIN;
    $('#leaveBanner').className = 'next-line' + (warnZone ? ' warn' : '');
    const what = S.eventName === 'your next thing' ? 'Next thing' : S.eventName;
    $('#leaveBanner').textContent = leftMs <= 0 ? `Time to go: ${what}`
      : warnZone ? `Leave in ${leftMin} min for ${what}`
      : `Next: ${what} at ${fmtTime(S.eventAt)}`;
    $('#leavePill').hidden = false;
    $('#leavePill').className = 'pill' + (warnZone ? ' warn' : '');
    $('#leavePill').textContent = `Leave ${fmtTime(S.leaveAt)}`;

    if (!S.warned && leftMs <= settings.warn * MIN && leftMs > 0) {
      S.warned = true; saveState();
      chime();
      toast(`${leftMin} min left. Start wrapping up and save your work.`);
      notify('Heads-up', `${leftMin} min until you leave for ${S.eventName}.`);
      announce(`${leftMin} minutes until you leave.`);
    }
    if (leftMs <= 0 && $('#alarm').hidden) leaveAlarm();

    // step timer
    const step = S.steps[S.idx];
    if (step) {
      const elapsed = (S.pausedAt || now) - S.stepStartedAt - (S.pausedTotal || 0);
      const rem = step.minutes * MIN - elapsed;
      const abs = Math.abs(rem);
      const mm = String(Math.floor(abs / MIN)).padStart(2, '0');
      const ss = String(Math.floor((abs % MIN) / 1000)).padStart(2, '0');
      $('#stepTimer').textContent = (rem < 0 ? '+' : '') + `${mm}:${ss}`;
      $('#stepTimer').classList.toggle('over', rem < 0);
      renderDisc(now, rem);
      if (rem <= 0 && !S.stepChimed && !S.pausedAt) {
        S.stepChimed = true; saveState();
        chime();
        $('#stepHint').textContent = 'Time\'s up for this one. Done? If not, split it or keep going.';
      }
      const minMark = Math.floor(rem / MIN);
      if (minMark !== lastAnnouncedMin && rem > 0 && minMark % 5 === 0) {
        lastAnnouncedMin = minMark;
        announce(`${minMark} minutes left on this step.`);
      }
      document.title = `${rem < 0 ? '+' : ''}${mm}:${ss} (leave ${fmtTime(S.leaveAt)})`;
    }
  }
  try {
    const w = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 1000)'], { type: 'text/javascript' })));
    w.onmessage = tick;
  } catch {
    setInterval(tick, 1000);
  }
  document.addEventListener('visibilitychange', tick);

  // ---------- settings ----------
  $('#settingsBtn').addEventListener('click', () => {
    $('#warnMins').value = settings.warn;
    $('#textSize').value = settings.scale;
    $('#theme').value = settings.theme;
    $('#provider').value = settings.provider;
    $('#apiKey').value = settings.key;
    $('#model').value = settings.model;
    $('#proxyUrl').value = settings.proxy || PROXY_URL;
    $('#aiStatus').textContent = aiMode() === 'own' ? 'AI is on, using your own key.'
      : aiMode() === 'shared' ? 'AI is on, using the shared server.' : 'AI is off. The built-in planner is used.';
    $('#settings').showModal();
  });
  $('#provider').addEventListener('change', (e) => ($('#model').value = DEFAULT_MODEL[e.target.value]));
  $('#settings').addEventListener('close', () => {
    settings = {
      warn: clamp(+$('#warnMins').value || 5, 1, 30),
      scale: +$('#textSize').value || 1,
      theme: $('#theme').value,
      provider: $('#provider').value,
      key: $('#apiKey').value.trim(),
      model: $('#model').value.trim() || DEFAULT_MODEL[$('#provider').value],
      proxy: $('#proxyUrl').value.trim() === PROXY_URL ? '' : $('#proxyUrl').value.trim()
    };
    store('fp_settings', settings);
    applySettings();
    if (S && !$('#plan').hidden) renderPlan();
  });
  $('#testSound').addEventListener('click', () => {
    ensureAudio(); chime();
    setTimeout(() => { startAlarmSound(); setTimeout(stopAlarmSound, 2500); }, 1300);
  });

  // ---------- install as an app (PWA) ----------
  // Service workers need http(s): works on GitHub Pages or a local server, not a double-clicked file.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('#installBtn').hidden = false;
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch {}
    installPrompt = null;
    $('#installBtn').hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    $('#installBtn').hidden = true;
    toast('FreePeriod is installed. Open it from your home screen or app list.');
  });

  // ---------- boot: survive a page refresh ----------
  if (S && S.running && S.leaveAt > Date.now() - 30 * MIN) {
    show('focus'); renderFocus();
    toast('Picked up where you left off. Click anywhere to re-enable sound.');
    document.addEventListener('pointerdown', ensureAudio, { once: true });
  } else if (S && !S.running && S.steps && S.steps.length) {
    renderPlan(); show('plan');
  } else {
    S = null; drop('fp_state');
    initSetup(); show('setup');
  }
  // Open the tab that makes sense: a running session → Plan, otherwise where you left off (Week the first time).
  switchTab(S ? 'plan' : TABS.includes(load('fp_tab', '')) ? load('fp_tab', '') : 'week');
  updateDots();
})();
