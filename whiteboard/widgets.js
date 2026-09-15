// widgets.js — THE WIDGETS: sounds/fireworks helpers, a DEFS table with one
// entry per widget type, the generic widget frame (drag/resize/close/persist),
// rail buttons, mobile rail toggle, restore on load.
// Plain (non-module) script loaded from index.html AFTER the markup so
// #widget-layer / #widget-rail exist. Runs before board.js (module scripts are
// deferred). Widgets are local to this device (localStorage), not synced.
// Reads window.WHITEBOARD_CONFIG.bellSchedule (config.js) for the period timer.
// See "ADDING A WIDGET" at the top of index.html.

// ═══════════════════════════════════════════════════════════════════════
//  WIDGETS — Classroomscreen-style floating tools that sit over the board.
//  Widgets are screen-fixed (they don't pan/zoom with the canvas) and are
//  saved to localStorage so they come back on reload. They're local to
//  this device; strokes are still synced through Firebase.
// ═══════════════════════════════════════════════════════════════════════
(() => {
    const layer = document.getElementById('widget-layer');
    const STORAGE_KEY = 'whiteboard.widgets.v1';
    const widgets = new Map();          // id -> { el, type, state, cleanup }  (every open widget)
    // Persistence: on any change, `save()` debounces a write of [{id,type,x,y,w,h,state}] to localStorage.
    // On load, the same list is replayed through addWidget().
    let zTop = 100;
    let saveTimer = null;

    const save = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            const out = [];
            for (const [id, w] of widgets) {
                const r = w.el;
                out.push({ id, type: w.type, x: r.offsetLeft, y: r.offsetTop, w: r.offsetWidth, h: r.offsetHeight, state: w.state });
            }
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(out)); } catch (e) { }
        }, 150);
    };

    // Small DOM helpers used by every widget: icon(lucideName), el(tag, className, text), pad(2 digits),
    // fmtTime(ms → m:ss or h:mm:ss), fitReadout(scale a big number to the widget width).
    const icon = name => { const i = document.createElement('i'); i.setAttribute('data-lucide', name); return i; };
    const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const pad = n => String(n).padStart(2, '0');
    const fmtTime = ms => {
        const t = Math.max(0, Math.round(ms / 1000));
        const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    };
    // Fit readout font to widget width
    const fitReadout = (widget, chars) => {
        const w = widget.offsetWidth - 40;
        widget.style.setProperty('--readout', `${Math.max(24, Math.min(160, w / (chars * 0.62)))}px`);
    };

    // ─── Sounds & effects ─── all synthesized with WebAudio, no audio files needed.
    // Browsers require a user gesture before audio plays; the first click on Start/Roll/Meow unlocks it.
    // Alarm sound without any assets — a few short beeps
    let audioCtx = null;
    function beep(times = 3) {
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            for (let i = 0; i < times; i++) {
                const o = audioCtx.createOscillator(), g = audioCtx.createGain();
                o.type = 'sine'; o.frequency.value = 880;
                g.gain.value = 0.0001;
                o.connect(g); g.connect(audioCtx.destination);
                const t = audioCtx.currentTime + i * 0.35;
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
                g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
                o.start(t); o.stop(t + 0.3);
            }
        } catch (e) { }
    }

    // School-bell chime (from the classroom file)
    function bell() {
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            const o1 = audioCtx.createOscillator(), o2 = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime;
            o1.type = 'sine'; o1.frequency.value = 880; o2.type = 'triangle'; o2.frequency.value = 440;
            g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.01, t + 1.2);
            [o1, o2].forEach(o => { o.connect(g); o.start(t); o.stop(t + 1.2); });
            g.connect(audioCtx.destination);
        } catch (e) { }
    }

    // Fireworks overlay — fired when a timer finishes
    const fw = document.getElementById('fireworks-canvas'), fwCtx = fw.getContext('2d');
    let particles = [];
    const sizeFw = () => { fw.width = innerWidth; fw.height = innerHeight; };
    addEventListener('resize', sizeFw); sizeFw();
    function fireworks() {
        const palette = ['#ff0055', '#00ffcc', '#ffcc00', '#ff00ff', '#00ff00', '#2288ff'];
        for (let b = 0; b < 5; b++) setTimeout(() => {
            const tx = fw.width * (0.2 + Math.random() * 0.6), ty = fw.height * (0.15 + Math.random() * 0.4), c = palette[b % palette.length];
            for (let p = 0; p < 60; p++) {
                const a = Math.random() * Math.PI * 2, sp = Math.random() * 6 + 2;
                particles.push({ x: tx, y: ty, c, r: Math.random() * 2.5 + 1, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, al: 1, d: Math.random() * 0.015 + 0.015 });
            }
            bell();
        }, b * 220);
        if (!fwRunning) { fwRunning = true; requestAnimationFrame(fwLoop); }
    }
    let fwRunning = false;
    function fwLoop() {
        fwCtx.clearRect(0, 0, fw.width, fw.height);
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.vx *= 0.98; p.vy = p.vy * 0.98 + 0.06; p.x += p.vx; p.y += p.vy; p.al -= p.d;
            if (p.al <= 0) { particles.splice(i, 1); continue; }
            fwCtx.globalAlpha = p.al; fwCtx.fillStyle = p.c; fwCtx.beginPath(); fwCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2); fwCtx.fill();
        }
        fwCtx.globalAlpha = 1;
        if (particles.length) requestAnimationFrame(fwLoop); else fwRunning = false;
    }

    // ─── Widget definitions ──────────────────────────────────────────
    // DEFS[type] = { title, icon, w, h, mount(body, state, ctx) → cleanup? }
    //   body   – the widget's content <div>; append your UI here
    //   state  – plain object that is persisted automatically; put anything the widget
    //            should remember on it (timer length, names list, chosen lamp...). Call
    //            save() after changing it.
    //   ctx    – { widget: the outer element, onResize(cb): run cb when the user resizes }
    //   return – optional function run when the widget is closed (stop timers, mic, rAF)
    // Widgets must stopPropagation() on keydown/keyup inside text inputs so the board's
    // Space-to-pan and Ctrl+Z shortcuts don't fire while typing.
    const DEFS = {
        // Clock: live time + date, 12/24h toggle.
        clock: {
            title: 'Clock', icon: 'clock', w: 300, h: 170,
            mount(body, state, ctx) {
                state.h24 = state.h24 ?? false;
                const read = el('div', 'readout');
                const date = el('div', 'text-center text-sm text-gray-500 font-medium');
                const tog = el('button', 'wbtn small self-center mt-2');
                body.append(read, date, tog);
                const tick = () => {
                    const d = new Date();
                    let h = d.getHours(), suffix = '';
                    if (!state.h24) { suffix = h >= 12 ? ' PM' : ' AM'; h = h % 12 || 12; }
                    read.textContent = `${state.h24 ? pad(h) : h}:${pad(d.getMinutes())}${suffix}`;
                    date.textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
                    tog.textContent = state.h24 ? '24h' : '12h';
                    fitReadout(ctx.widget, state.h24 ? 5 : 8);
                };
                tog.onclick = () => { state.h24 = !state.h24; tick(); save(); };
                tick();
                const id = setInterval(tick, 1000);
                ctx.onResize(tick);
                return () => clearInterval(id);
            }
        },

        // Timer: countdown with presets + custom minutes. Uses an absolute endAt timestamp so it
        // stays accurate even if the tab is throttled. Fireworks + bell when it reaches zero.
        timer: {
            title: 'Timer', icon: 'timer', w: 320, h: 230,
            mount(body, state, ctx) {
                state.total = state.total ?? 5 * 60 * 1000;   // ms configured
                state.remaining = state.remaining ?? state.total;
                state.running = false; state.endAt = null;
                let fired = false;

                const read = el('div', 'readout');
                const bar = el('div', 'h-1.5 rounded-full bg-gray-100 overflow-hidden my-2');
                const fill = el('div', 'h-full bg-blue-600 rounded-full'); bar.append(fill);
                const presets = el('div', 'flex flex-wrap gap-1 justify-center');
                [1, 2, 5, 10, 15, 30].forEach(m => {
                    const b = el('button', 'wbtn small', `${m}m`);
                    b.onclick = () => { stop(); state.total = state.remaining = m * 60000; render(); save(); };
                    presets.append(b);
                });
                const custom = el('input', 'wbtn small w-14 text-center');
                custom.type = 'number'; custom.min = 1; custom.placeholder = 'min';
                custom.onchange = () => { const m = parseFloat(custom.value); if (m > 0) { stop(); state.total = state.remaining = m * 60000; render(); save(); } custom.value = ''; };
                presets.append(custom);
                const row = el('div', 'flex gap-2 justify-center mt-2');
                const start = el('button', 'wbtn primary', 'Start');
                const reset = el('button', 'wbtn', 'Reset');
                row.append(start, reset);
                body.append(read, bar, presets, row);

                const render = () => {
                    read.textContent = fmtTime(state.remaining);
                    read.style.color = state.remaining <= 0 ? '#dc2626' : (state.remaining <= 10000 && state.running ? '#ea580c' : '');
                    fill.style.width = `${Math.max(0, state.remaining / state.total) * 100}%`;
                    start.textContent = state.running ? 'Pause' : 'Start';
                    fitReadout(ctx.widget, read.textContent.length);
                };
                const stop = () => { state.running = false; state.endAt = null; };
                const tick = () => {
                    if (!state.running) return;
                    state.remaining = state.endAt - Date.now();
                    if (state.remaining <= 0) {
                        state.remaining = 0; stop();
                        if (!fired) { fired = true; fireworks(); ctx.widget.animate([{ background: '#fecaca' }, { background: '' }], { duration: 1200, iterations: 3 }); }
                    }
                    render();
                };
                start.onclick = () => {
                    if (state.running) { stop(); }
                    else {
                        if (state.remaining <= 0) state.remaining = state.total;
                        fired = false; state.running = true; state.endAt = Date.now() + state.remaining;
                        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
                    }
                    render(); save();
                };
                reset.onclick = () => { stop(); state.remaining = state.total; fired = false; render(); save(); };
                render();
                const id = setInterval(tick, 200);
                ctx.onResize(render);
                return () => clearInterval(id);
            }
        },

        // Stopwatch: elapsed is stored when paused; while running it's elapsed + (now − startAt).
        stopwatch: {
            title: 'Stopwatch', icon: 'watch', w: 300, h: 190,
            mount(body, state, ctx) {
                state.elapsed = state.elapsed ?? 0; let running = false, startAt = 0;
                const read = el('div', 'readout');
                const row = el('div', 'flex gap-2 justify-center mt-2');
                const start = el('button', 'wbtn primary', 'Start');
                const reset = el('button', 'wbtn', 'Reset');
                row.append(start, reset); body.append(read, row);
                const now = () => running ? state.elapsed + (Date.now() - startAt) : state.elapsed;
                const render = () => {
                    const ms = now();
                    read.textContent = `${fmtTime(ms)}.${pad(Math.floor((ms % 1000) / 10))}`;
                    start.textContent = running ? 'Pause' : 'Start';
                    fitReadout(ctx.widget, read.textContent.length);
                };
                start.onclick = () => {
                    if (running) { state.elapsed = now(); running = false; save(); }
                    else { startAt = Date.now(); running = true; }
                    render();
                };
                reset.onclick = () => { running = false; state.elapsed = 0; render(); save(); };
                render();
                const id = setInterval(() => { if (running) render(); }, 50);
                ctx.onResize(render);
                return () => clearInterval(id);
            }
        },

        // Calendar: simple month grid, today highlighted, ‹ › to browse months (not persisted).
        calendar: {
            title: 'Calendar', icon: 'calendar', w: 300, h: 300,
            mount(body, state, ctx) {
                const today = new Date();
                let y = today.getFullYear(), m = today.getMonth();
                const head = el('div', 'flex items-center justify-between mb-2');
                const prev = el('button', 'wbtn small', '‹'), next = el('button', 'wbtn small', '›');
                const label = el('div', 'font-bold text-gray-800');
                head.append(prev, label, next);
                const grid = el('div', 'grid grid-cols-7 gap-1 text-center text-sm flex-1');
                body.append(head, grid);
                const render = () => {
                    label.textContent = new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
                    grid.innerHTML = '';
                    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(d => grid.append(el('div', 'text-xs font-bold text-gray-400', d)));
                    const first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
                    for (let i = 0; i < first; i++) grid.append(el('div'));
                    for (let d = 1; d <= days; d++) {
                        const isToday = d === today.getDate() && m === today.getMonth() && y === today.getFullYear();
                        grid.append(el('div', 'rounded-lg py-1 flex items-center justify-center ' + (isToday ? 'bg-blue-600 text-white font-bold' : 'text-gray-700'), d));
                    }
                };
                prev.onclick = () => { m--; if (m < 0) { m = 11; y--; } render(); };
                next.onclick = () => { m++; if (m > 11) { m = 0; y++; } render(); };
                render();
            }
        },

        // Text: a big editable textarea with A+/A− size buttons. Text and size persist.
        text: {
            title: 'Text', icon: 'type', w: 340, h: 220,
            mount(body, state, ctx) {
                state.text = state.text ?? ''; state.size = state.size ?? 22;
                const ta = el('textarea', 'flex-1 w-full resize-none leading-snug');
                ta.placeholder = 'Type here…'; ta.value = state.text;
                ta.style.fontSize = state.size + 'px';
                const bar = el('div', 'flex gap-1 justify-end mt-2');
                const minus = el('button', 'wbtn small', 'A−'), plus = el('button', 'wbtn small', 'A+');
                minus.onclick = () => { state.size = Math.max(12, state.size - 2); ta.style.fontSize = state.size + 'px'; save(); };
                plus.onclick = () => { state.size = Math.min(96, state.size + 2); ta.style.fontSize = state.size + 'px'; save(); };
                bar.append(minus, plus); body.append(ta, bar);
                ta.oninput = () => { state.text = ta.value; save(); };
                // Stop board shortcuts (space → pan) while typing
                ta.addEventListener('keydown', e => e.stopPropagation());
                ta.addEventListener('keyup', e => e.stopPropagation());
                setTimeout(() => ta.focus(), 0);
            }
        },

        // Random name picker: names live in a textarea (one per line). 'No repeats' remembers who
        // has been picked this session; the pool refills when everyone has had a turn.
        names: {
            title: 'Random name', icon: 'shuffle', w: 320, h: 300,
            mount(body, state, ctx) {
                state.names = state.names ?? ''; state.noRepeat = state.noRepeat ?? true;
                let used = new Set();
                const result = el('div', 'readout');
                result.style.fontFamily = 'inherit';
                result.textContent = '?';
                const ta = el('textarea', 'w-full text-sm border border-gray-200 rounded-lg p-2 resize-none');
                ta.rows = 4; ta.placeholder = 'One name per line'; ta.value = state.names;
                ta.oninput = () => { state.names = ta.value; used.clear(); save(); };
                ta.addEventListener('keydown', e => e.stopPropagation());
                ta.addEventListener('keyup', e => e.stopPropagation());
                const row = el('div', 'flex items-center gap-2 mt-2');
                const pick = el('button', 'wbtn primary flex-1', 'Pick a name');
                const rep = el('label', 'flex items-center gap-1 text-xs text-gray-500');
                const cb = el('input'); cb.type = 'checkbox'; cb.checked = state.noRepeat;
                cb.onchange = () => { state.noRepeat = cb.checked; used.clear(); save(); };
                rep.append(cb, 'No repeats');
                const editBtn = el('button', 'wbtn small', 'Edit');
                row.append(pick, editBtn);
                body.append(result, row, rep, ta);
                ta.style.display = state.names ? 'none' : '';
                editBtn.onclick = () => { ta.style.display = ta.style.display === 'none' ? '' : 'none'; if (ta.style.display !== 'none') ta.focus(); };
                pick.onclick = () => {
                    const all = state.names.split('\n').map(s => s.trim()).filter(Boolean);
                    if (!all.length) { ta.style.display = ''; ta.focus(); return; }
                    let pool = state.noRepeat ? all.filter(n => !used.has(n)) : all;
                    if (!pool.length) { used.clear(); pool = all; }
                    // quick shuffle animation, then land
                    let n = 0; pick.disabled = true;
                    const spin = setInterval(() => {
                        result.textContent = all[Math.floor(Math.random() * all.length)];
                        if (++n > 12) {
                            clearInterval(spin);
                            const chosen = pool[Math.floor(Math.random() * pool.length)];
                            used.add(chosen); result.textContent = chosen; pick.disabled = false;
                            fit();
                        }
                    }, 60);
                };
                const fit = () => fitReadout(ctx.widget, Math.max(4, result.textContent.length));
                fit(); ctx.onResize(fit);
            }
        },

        // Dice: 1–3 dice drawn as a 3×3 pip grid; PIPS maps a face value to which cells are on.
        dice: {
            title: 'Dice', icon: 'dices', w: 260, h: 200,
            mount(body, state, ctx) {
                state.count = state.count ?? 1; state.values = state.values ?? [1];
                const area = el('div', 'flex-1 flex items-center justify-center gap-3 flex-wrap');
                const total = el('div', 'text-center text-sm text-gray-500 font-semibold');
                const row = el('div', 'flex gap-2 justify-center mt-2 items-center');
                const roll = el('button', 'wbtn primary', 'Roll');
                const cnt = el('select', 'wbtn small');
                [1, 2, 3].forEach(n => { const o = el('option', '', `${n} ${n > 1 ? 'dice' : 'die'}`); o.value = n; cnt.append(o); });
                cnt.value = state.count;
                row.append(roll, cnt); body.append(area, total, row);
                const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
                const render = () => {
                    area.innerHTML = '';
                    state.values.forEach(v => {
                        const d = el('div', 'die');
                        for (let i = 0; i < 9; i++) { const s = el('span'); if (PIPS[v].includes(i)) s.classList.add('on'); d.append(s); }
                        area.append(d);
                    });
                    total.textContent = state.values.length > 1 ? `Total: ${state.values.reduce((a, b) => a + b, 0)}` : '';
                };
                roll.onclick = () => {
                    state.values = Array.from({ length: state.count }, () => 1 + Math.floor(Math.random() * 6));
                    render(); area.querySelectorAll('.die').forEach(d => d.classList.add('rolling')); save();
                };
                cnt.onchange = () => { state.count = +cnt.value; state.values = Array.from({ length: state.count }, () => 1 + Math.floor(Math.random() * 6)); render(); save(); };
                render();
            }
        },

        // Traffic light: tap a lamp to light it (tap again to turn all off). Persists which is on.
        traffic: {
            title: 'Traffic light', icon: 'traffic-cone', w: 160, h: 320,
            mount(body, state, ctx) {
                state.on = state.on ?? 'green';
                const box = el('div', 'flex-1 flex flex-col justify-around gap-2 rounded-2xl bg-slate-800 p-3');
                const lamps = { red: '#ef4444', yellow: '#facc15', green: '#22c55e' };
                for (const [k, c] of Object.entries(lamps)) {
                    const l = el('div', 'tl-lamp'); l.style.background = c; l.style.color = c; l.dataset.k = k;
                    l.onclick = () => { state.on = state.on === k ? null : k; render(); save(); };
                    box.append(l);
                }
                body.append(box);
                const render = () => box.querySelectorAll('.tl-lamp').forEach(l => l.classList.toggle('on', l.dataset.k === state.on));
                render();
            }
        },

        // Work symbols: Silence / Whisper / Partner / Group / Ask — one active at a time.
        symbols: {
            title: 'Work symbols', icon: 'users', w: 300, h: 150,
            mount(body, state, ctx) {
                state.mode = state.mode ?? 'silence';
                const SYMS = [['silence', 'mic-off', 'Silence'], ['whisper', 'ear', 'Whisper'], ['partner', 'user-round', 'Partner'], ['group', 'users', 'Group work'], ['ask', 'hand', 'Ask']];
                const grid = el('div', 'grid grid-cols-5 gap-1 flex-1 items-center');
                SYMS.forEach(([k, ic, lb]) => {
                    const b = el('button', 'sym-btn'); b.dataset.k = k; b.append(icon(ic), el('span', '', lb));
                    b.onclick = () => { state.mode = k; render(); save(); };
                    grid.append(b);
                });
                body.append(grid);
                const render = () => grid.querySelectorAll('.sym-btn').forEach(b => b.classList.toggle('on', b.dataset.k === state.mode));
                render();
            }
        },

        // Period timer / bell schedule: counts down the current period from the device clock.
        // state.periods = [[name, 'HH:MM', 'HH:MM'], ...] (24h). Editable in-widget; rings a
        // bell when the active period changes. Also counts down passing periods to the next start.
        schedule: {
            title: 'Period timer', icon: 'bell', w: 320, h: 440,
            mount(body, state, ctx) {
                // Default schedule comes from config.js (bellSchedule); editable and saved per device
                state.periods = state.periods ?? window.WHITEBOARD_CONFIG.bellSchedule.map(p => p.slice());
                state.ring = state.ring ?? true;

                const big = el('div', 'rounded-xl bg-blue-50 border border-blue-100 text-center py-2 mb-2');
                const bigLabel = el('div', 'text-[10px] font-bold uppercase tracking-widest text-blue-500', 'Time remaining');
                const bigRead = el('div', 'readout', '--:--'); bigRead.style.flex = '0'; bigRead.style.padding = '4px 0';
                const bigName = el('div', 'text-sm font-semibold text-gray-700');
                big.append(bigLabel, bigRead, bigName);
                const list = el('div', 'flex-1 overflow-auto text-xs divide-y divide-gray-100');
                const editor = el('textarea', 'hidden flex-1 w-full text-xs font-mono border border-gray-200 rounded-lg p-2 resize-none');
                editor.placeholder = 'Name | start | end  (24h, one per line)\n1st Period | 08:01 | 08:47';
                editor.addEventListener('keydown', e => e.stopPropagation()); editor.addEventListener('keyup', e => e.stopPropagation());
                const bar = el('div', 'flex items-center gap-2 mt-2');
                const editBtn = el('button', 'wbtn small', 'Edit schedule');
                const ringLbl = el('label', 'flex items-center gap-1 text-xs text-gray-500 ml-auto');
                const ringCb = el('input'); ringCb.type = 'checkbox'; ringCb.checked = state.ring;
                ringCb.onchange = () => { state.ring = ringCb.checked; save(); };
                ringLbl.append(ringCb, 'Ring bell');
                bar.append(editBtn, ringLbl);
                body.append(big, list, editor, bar);

                const toSecs = t => { const [h, m] = t.split(':').map(Number); return h * 3600 + m * 60; };
                const fmt12 = t => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${pad(m)}`; };
                const buildList = () => {
                    list.innerHTML = '';
                    state.periods.forEach(([name, s, e], i) => {
                        const row = el('div', 'flex justify-between items-center py-1 px-1 rounded');
                        row.dataset.i = i;
                        row.append(el('span', 'font-medium text-gray-700 truncate', name), el('span', 'font-mono text-gray-400', `${fmt12(s)} – ${fmt12(e)}`));
                        list.append(row);
                    });
                };
                let lastActive = null, ready = false;
                const tick = () => {
                    const d = new Date(), secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
                    let active = -1, end = null, nextStart = null;
                    state.periods.forEach(([name, s, e], i) => {
                        const ss = toSecs(s), es = toSecs(e);
                        if (secs >= ss && secs < es) { active = i; end = es; }
                        if (ss > secs && (nextStart === null || ss < nextStart)) nextStart = ss;
                    });
                    list.querySelectorAll('[data-i]').forEach(r => {
                        const on = +r.dataset.i === active;
                        r.className = 'flex justify-between items-center py-1 px-1 rounded ' + (on ? 'bg-blue-100 text-blue-700 font-bold' : '');
                        if (on) r.firstChild.classList.replace('text-gray-700', 'text-blue-700');
                    });
                    if (active >= 0) {
                        const diff = end - secs;
                        bigRead.textContent = `${Math.floor(diff / 60)}:${pad(diff % 60)}`;
                        bigRead.style.color = diff <= 60 ? '#dc2626' : '';
                        bigName.textContent = state.periods[active][0];
                        bigLabel.textContent = 'Time remaining';
                    } else if (nextStart !== null) {
                        const diff = nextStart - secs;
                        bigRead.textContent = `${Math.floor(diff / 60)}:${pad(diff % 60)}`; bigRead.style.color = '#64748b';
                        bigName.textContent = 'Passing period'; bigLabel.textContent = 'Next period in';
                    } else {
                        bigRead.textContent = '--:--'; bigRead.style.color = '#64748b';
                        bigName.textContent = 'No more periods today'; bigLabel.textContent = 'Schedule';
                    }
                    // Bell when the active period changes (after first tick so a reload doesn't ring)
                    if (ready && state.ring && active !== lastActive && lastActive !== null) bell();
                    lastActive = active; ready = true;
                    fitReadout(ctx.widget, 7);
                };
                editBtn.onclick = () => {
                    const editing = editor.classList.toggle('hidden');
                    list.classList.toggle('hidden', !editing);
                    if (!editing) {
                        editor.value = state.periods.map(p => p.join(' | ')).join('\n'); editor.focus(); editBtn.textContent = 'Save schedule';
                    } else {
                        const rows = editor.value.split('\n').map(l => l.split('|').map(s => s.trim())).filter(r => r.length === 3 && /^\d{1,2}:\d{2}$/.test(r[1]) && /^\d{1,2}:\d{2}$/.test(r[2]));
                        if (rows.length) state.periods = rows;
                        editBtn.textContent = 'Edit schedule'; buildList(); tick(); save();
                    }
                };
                buildList(); tick();
                const id = setInterval(tick, 1000);
                ctx.onResize(tick);
                return () => clearInterval(id);
            }
        },

        // QR code: renders whatever is in the input (defaults to this page's URL) via qrcode.js,
        // sized to fit the widget.
        qr: {
            title: 'QR code', icon: 'qr-code', w: 240, h: 300,
            mount(body, state, ctx) {
                state.text = state.text ?? location.href;
                const box = el('div', 'flex-1 flex items-center justify-center min-h-0');
                const holder = el('div', 'bg-white p-2 rounded-lg');
                box.append(holder);
                const input = el('input', 'w-full text-xs font-mono border border-gray-200 rounded-lg px-2 py-1 mt-2');
                input.type = 'text'; input.value = state.text; input.placeholder = 'Link or text';
                input.addEventListener('keydown', e => e.stopPropagation()); input.addEventListener('keyup', e => e.stopPropagation());
                body.append(box, input);
                let qr = null;
                const render = () => {
                    const size = Math.max(80, Math.min(ctx.widget.offsetWidth, ctx.widget.offsetHeight - 110) - 50);
                    holder.innerHTML = '';
                    if (!window.QRCode) { holder.textContent = 'QR library failed to load'; return; }
                    qr = new QRCode(holder, { text: state.text || ' ', width: size, height: size, colorDark: '#0f172a', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
                };
                input.oninput = () => { state.text = input.value; render(); save(); };
                render(); ctx.onResize(render);
            }
        },

        // Wandering cat: purely decorative. rAF loop moves an inline SVG around its box and
        // flips it to face its direction. Walk / Run / Sleep states, synthesized meow.
        cat: {
            title: 'Wandering cat', icon: 'cat', w: 300, h: 220,
            mount(body, state, ctx) {
                const yard = el('div', 'flex-1 relative overflow-hidden rounded-xl bg-slate-100 border border-slate-200 min-h-[90px]');
                const cat = el('div', 'absolute w-16 h-16 transition-transform duration-100 ease-linear');
                cat.innerHTML = `<svg viewBox="0 0 100 100" class="w-full h-full text-indigo-500 fill-current">
                    <path d="M22,50 Q10,40 16,25 Q22,10 32,20 Q26,30 28,40" class="cat-tail"/>
                    <ellipse cx="50" cy="58" rx="22" ry="16"/><circle cx="72" cy="45" r="14"/>
                    <polygon points="63,35 66,18 72,32"/><polygon points="76,32 82,18 85,35"/>
                    <rect x="34" y="66" width="7" height="14" rx="3" class="cat-leg"/><rect x="44" y="68" width="7" height="14" rx="3" class="cat-leg"/>
                    <rect x="54" y="68" width="7" height="14" rx="3" class="cat-leg"/><rect x="63" y="66" width="7" height="14" rx="3" class="cat-leg"/>
                    <circle cx="77" cy="42" r="2" fill="#fff"/><circle cx="68" cy="42" r="2" fill="#fff"/></svg>`;
                yard.append(cat);
                const row = el('div', 'flex gap-2 justify-center mt-2');
                const stateBtn = el('button', 'wbtn small', 'Walk'), meow = el('button', 'wbtn small primary', 'Meow');
                row.append(stateBtn, meow); body.append(yard, row);
                let x = 10, y = 20, vx = 1.2, vy = 0.3, mode = 'walk', raf;
                const modes = ['walk', 'run', 'sleep'];
                stateBtn.onclick = () => { mode = modes[(modes.indexOf(mode) + 1) % 3]; stateBtn.textContent = mode[0].toUpperCase() + mode.slice(1); cat.classList.toggle('cat-sleep', mode === 'sleep'); };
                meow.onclick = () => {
                    try {
                        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
                        if (audioCtx.state === 'suspended') audioCtx.resume();
                        const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime;
                        o.type = 'triangle';
                        o.frequency.setValueAtTime(320, t); o.frequency.exponentialRampToValueAtTime(580, t + 0.15); o.frequency.exponentialRampToValueAtTime(420, t + 0.45);
                        g.gain.setValueAtTime(0.01, t); g.gain.linearRampToValueAtTime(0.25, t + 0.08); g.gain.exponentialRampToValueAtTime(0.01, t + 0.5);
                        o.connect(g); g.connect(audioCtx.destination); o.start(t); o.stop(t + 0.55);
                    } catch (e) { }
                    meow.textContent = 'Meow! 🐱'; setTimeout(() => meow.textContent = 'Meow', 800);
                };
                const step = () => {
                    if (mode !== 'sleep') {
                        const sp = mode === 'run' ? 2.6 : 1;
                        x += vx * sp; y += vy * sp;
                        const mw = yard.clientWidth - 64, mh = yard.clientHeight - 64;
                        if (x <= 0 || x >= mw) { vx = -vx; x = Math.max(0, Math.min(mw, x)); }
                        if (y <= 0 || y >= mh) { vy = -vy; y = Math.max(0, Math.min(mh, y)); }
                        if (Math.random() < 0.01) vy = (Math.random() - 0.5) * 0.8;
                        cat.style.transform = `translate(${x}px, ${y}px) scaleX(${vx < 0 ? -1 : 1})`;
                    }
                    raf = requestAnimationFrame(step);
                };
                step();
                return () => cancelAnimationFrame(raf);
            }
        },

        // Noise meter: microphone RMS level (0–100 rough scale) drawn as a bar; a dashed line marks
        // the adjustable 'too loud' threshold. Mic is released when stopped or the widget closes.
        noise: {
            title: 'Noise meter', icon: 'volume-2', w: 220, h: 280,
            mount(body, state, ctx) {
                state.threshold = state.threshold ?? 60;
                const meter = el('div', 'flex-1 rounded-xl bg-gray-100 overflow-hidden relative');
                const bar = el('div', 'noise-bar');
                bar.style.background = 'linear-gradient(to top, #22c55e, #facc15 60%, #ef4444)';
                bar.style.transform = 'scaleY(0)';
                const line = el('div', 'absolute left-0 right-0 border-t-2 border-dashed border-red-500');
                meter.append(bar, line);
                const label = el('div', 'text-center text-xs text-gray-500 mt-2', 'Tap Start to use the microphone');
                const row = el('div', 'flex items-center gap-2 mt-2');
                const start = el('button', 'wbtn primary flex-1', 'Start');
                const thr = el('input'); thr.type = 'range'; thr.min = 10; thr.max = 100; thr.value = state.threshold; thr.className = 'w-20 accent-red-500';
                row.append(start, thr); body.append(meter, label, row);
                const placeLine = () => { line.style.top = `${100 - state.threshold}%`; };
                thr.oninput = () => { state.threshold = +thr.value; placeLine(); save(); };
                placeLine();
                let stream = null, actx = null, raf = null, over = 0;
                const stop = () => {
                    if (raf) cancelAnimationFrame(raf); raf = null;
                    if (stream) stream.getTracks().forEach(t => t.stop()); stream = null;
                    if (actx) actx.close(); actx = null;
                    bar.style.transform = 'scaleY(0)'; start.textContent = 'Start'; label.textContent = 'Microphone off';
                };
                start.onclick = async () => {
                    if (stream) return stop();
                    try {
                        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                        actx = new (window.AudioContext || window.webkitAudioContext)();
                        const src = actx.createMediaStreamSource(stream), an = actx.createAnalyser();
                        an.fftSize = 512; src.connect(an);
                        const data = new Uint8Array(an.frequencyBinCount);
                        start.textContent = 'Stop';
                        const loop = () => {
                            an.getByteTimeDomainData(data);
                            let sum = 0; for (const v of data) { const d = (v - 128) / 128; sum += d * d; }
                            const rms = Math.sqrt(sum / data.length);
                            const level = Math.min(100, rms * 400);        // rough 0–100 scale
                            bar.style.transform = `scaleY(${level / 100})`;
                            if (level > state.threshold) { over++; if (over > 20) { label.textContent = 'Too loud!'; label.style.color = '#dc2626'; } }
                            else { over = 0; label.textContent = 'Listening…'; label.style.color = ''; }
                            raf = requestAnimationFrame(loop);
                        };
                        loop();
                    } catch (e) { label.textContent = 'Microphone access was blocked'; }
                };
                return stop;
            }
        }
    };

    // ─── Widget frame: drag, resize, focus, close ────────────────────
    // Builds the chrome around any DEFS entry: header (drag handle + close), body, resize grip.
    // opts may carry {id, x, y, w, h, state} when restoring from localStorage.
    // New widgets cascade diagonally so several opened in a row don't stack exactly on top.
    function addWidget(type, opts = {}) {
        const def = DEFS[type]; if (!def) return;
        const id = opts.id || crypto.randomUUID();
        const state = opts.state || {};
        const w = el('div', 'widget');
        const width = Math.min(opts.w || def.w, window.innerWidth - 16), height = Math.min(opts.h || def.h, window.innerHeight - 110);
        // Cascade new widgets so they don't stack exactly on top of each other
        const n = widgets.size;
        const x = opts.x ?? Math.min(window.innerWidth - width - 20, 90 + (n % 6) * 30);
        const y = opts.y ?? Math.min(window.innerHeight - height - 100, 80 + (n % 6) * 30);
        Object.assign(w.style, { left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px', zIndex: ++zTop });

        const head = el('div', 'widget-head');
        head.append(icon(def.icon), el('span', '', def.title), el('span', 'spacer'));
        const closeBtn = el('button', 'close'); closeBtn.title = 'Close'; closeBtn.append(icon('x'));
        head.append(closeBtn);
        const body = el('div', 'widget-body');
        const grip = el('div', 'widget-resize');
        w.append(head, body, grip);
        layer.append(w);

        const resizeCbs = [];
        const ctx = { widget: w, onResize: cb => resizeCbs.push(cb) };
        const cleanup = def.mount(body, state, ctx);
        lucide.createIcons({ nodes: w.querySelectorAll('[data-lucide]') });   // resolves the <i data-lucide> tags we just added

        const focus = () => { document.querySelectorAll('.widget.focused').forEach(x => x.classList.remove('focused')); w.classList.add('focused'); w.style.zIndex = ++zTop; };
        w.addEventListener('pointerdown', focus);

        // Drag by the header
        head.addEventListener('pointerdown', e => {
            if (e.target.closest('button')) return;
            e.preventDefault(); head.setPointerCapture(e.pointerId);
            const sx = e.clientX - w.offsetLeft, sy = e.clientY - w.offsetTop;
            const move = ev => {
                const nx = Math.max(-width + 60, Math.min(window.innerWidth - 60, ev.clientX - sx));
                const ny = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - sy));
                w.style.left = nx + 'px'; w.style.top = ny + 'px';
            };
            const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); save(); };
            head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
        });

        // Resize by the corner
        grip.addEventListener('pointerdown', e => {
            e.preventDefault(); e.stopPropagation(); grip.setPointerCapture(e.pointerId); focus();
            const sw = w.offsetWidth, sh = w.offsetHeight, sx = e.clientX, sy = e.clientY;
            const move = ev => {
                w.style.width = Math.max(180, sw + ev.clientX - sx) + 'px';
                w.style.height = Math.max(120, sh + ev.clientY - sy) + 'px';
                resizeCbs.forEach(cb => cb());
            };
            const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); save(); };
            grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
        });

        closeBtn.onclick = () => removeWidget(id);
        widgets.set(id, { el: w, type, state, cleanup });
        focus(); save();
        return w;
    }

    function removeWidget(id) {
        const w = widgets.get(id); if (!w) return;
        if (typeof w.cleanup === 'function') w.cleanup();
        w.el.remove(); widgets.delete(id); save();
    }

    // Click on empty board → unfocus widgets
    document.getElementById('overlayCanvas').addEventListener('pointerdown', () => {
        document.querySelectorAll('.widget.focused').forEach(x => x.classList.remove('focused'));
    });

    // Collapsible rail on small screens
    const rail = document.getElementById('widget-rail'), railToggle = document.getElementById('rail-toggle');
    railToggle.onclick = () => rail.classList.toggle('open');
    const isSmall = () => window.matchMedia('(max-width: 820px)').matches;

    // Keep widgets on screen when the viewport changes (rotation, keyboard, window resize)
    // Pull every widget back inside the viewport (rotation, keyboard, window resize, tiny screens).
    function clampAll() {
        for (const w of widgets.values()) {
            const r = w.el;
            const maxW = window.innerWidth - 16, maxH = window.innerHeight - 110;
            if (r.offsetWidth > maxW) r.style.width = maxW + 'px';
            if (r.offsetHeight > maxH) r.style.height = Math.max(120, maxH) + 'px';
            r.style.left = Math.max(0, Math.min(window.innerWidth - r.offsetWidth, r.offsetLeft)) + 'px';
            r.style.top = Math.max(0, Math.min(window.innerHeight - r.offsetHeight - 80, r.offsetTop)) + 'px';
        }
    }
    window.addEventListener('resize', clampAll);
    window.addEventListener('orientationchange', () => setTimeout(clampAll, 150));

    // Rail buttons
    document.querySelectorAll('#widget-rail button[data-widget]').forEach(b => b.onclick = () => { addWidget(b.dataset.widget); if (isSmall()) rail.classList.remove('open'); clampAll(); });
    document.getElementById('btn-widgets-clear').onclick = () => {
        if (!widgets.size) return;
        if (confirm('Close all widgets?')) [...widgets.keys()].forEach(removeWidget);
    };

    // Restore from last session (same shape as what save() writes)
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        saved.forEach(s => addWidget(s.type, s));
        document.querySelectorAll('.widget.focused').forEach(x => x.classList.remove('focused'));
    } catch (e) { }
})();
