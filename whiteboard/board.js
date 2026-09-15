// board.js — THE BOARD: state, canvas setup, Firebase sync, drawing helpers,
// render loop, pointer input (pen/touch/mouse/pinch), undo, toolbar wiring,
// touch & e-ink modes, minimap, keyboard shortcuts.
// Loaded from index.html as <script type="module" src="board.js">. Reads
// window.WHITEBOARD_CONFIG (config.js) for the Firebase config and app id.
// See the architecture overview at the top of index.html.

// Firebase is loaded as ES modules straight from Google's CDN. Version pinned to 11.6.1.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, collection, onSnapshot, doc, setDoc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

lucide.createIcons();

// ─── STATE ────────────────────────────────────────────────────────────────────
// ui: what the toolbar currently says. tool ∈ pen|eraser|arrow|rect|circle|text|select|pan.
// touchMode/eink are persisted in localStorage so they survive reloads.
const ui = { tool: 'pen', thickness: 3, color: '#000000', eraseMode: 'stroke', showGrid: true, touchMode: localStorage.getItem('whiteboard.touchMode') || 'draw', eink: localStorage.getItem('whiteboard.eink') === '1' };
// view: the camera. screen = world * zoom + (x, y). Not persisted — every reload starts at 100%/origin.
const view = { x: 0, y: 0, zoom: 1 };

let strokes = [];          // ground truth from Firestore
let undoStack = [];        // array of {type:'add'|'delete', strokes:[...]} for undo
let isDirty = true;

// Offscreen buffer: strokes are rendered here; only overlayCanvas is drawn fresh per frame
const offscreen = document.createElement('canvas');
const offCtx = offscreen.getContext('2d', { alpha: true });
let offscreenDirty = true; // needs full redraw
let offscreenView = { x: null, y: null, zoom: null }; // last view used to render offscreen

// Multi-touch bookkeeping. activePointers maps pointerId → last PointerEvent (needed for pinch).
const activePointers = new Map();
let isDrawing = false;
let isPanning = false;
let currentStroke = null;
let lastPt = null;
let initialPinchDistance = null;
let initialView = null;
let initialPinchCenter = null;

// Minimum distance squared to add a new point during drawing (reduces micro-movements)
const MIN_DRAW_DIST_SQ = 4; // 2px squared

// Stroke-erase hit-test state
let erasedThisGesture = new Set(); // ids erased so we don't double-erase

// ─── IMAGE PASTE state ───────────────────────────────────────────────────────
// imageCache: id → decoded HTMLImageElement (canvas needs a bitmap, not the src string).
// selectedObjectId / objectDrag: bookkeeping for the "select" tool (move/resize/delete).
const imageCache = new Map();
let selectedObjectId = null;
let objectDrag = null; // { id, mode: 'move'|'resize', orig:{x,y,w,h}, startWx, startWy }
// Text tool: `editing` is non-null while the #text-editor textarea is open.
// { id, x, y, size, color, isNew, before } — `before` is the original stroke when editing an existing one.
let editing = null;
const textEditor = document.getElementById('text-editor');

// ─── CANVAS SETUP ─────────────────────────────────────────────────────────────
// mainCtx: displays committed strokes. overlayCtx: live stroke + eraser cursor; `desynchronized`
// asks the browser to bypass its compositor queue for lower pen latency.
const container = document.getElementById('canvas-container');
const mainCanvas = document.getElementById('mainCanvas');
const mainCtx = mainCanvas.getContext('2d', { alpha: true });
const overlayCanvas = document.getElementById('overlayCanvas');
const overlayCtx = overlayCanvas.getContext('2d', { alpha: true, desynchronized: true });

// Size all three canvases to the window at device pixel ratio so lines are crisp on Retina/HiDPI.
// All drawing code works in CSS pixels; the base transform (setTransform) handles the scaling.
let dpr = 1;
function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, ui.eink ? 2 : 3);
    const w = window.innerWidth, h = window.innerHeight;
    for (const c of [mainCanvas, overlayCanvas, offscreen]) {
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
        c.style.width = w + 'px'; c.style.height = h + 'px';
    }
    // Draw in CSS pixels; the base transform maps them to device pixels (survives save/restore)
    for (const c of [mainCtx, overlayCtx, offCtx]) c.setTransform(dpr, 0, 0, dpr, 0, 0);
    offscreenDirty = true;
    isDirty = true;
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 100));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
resize();

// ─── FIREBASE ─────────────────────────────────────────────────────────────────
// __firebase_config / __app_id / __initial_auth_token are optional globals a hosting
// environment may inject. When absent, the web config from config.js + anonymous sign-in are used.
let firebaseConfig;
if (typeof __firebase_config !== 'undefined') {
    firebaseConfig = JSON.parse(__firebase_config);
} else {
    firebaseConfig = window.WHITEBOARD_CONFIG.firebase;
}
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : window.WHITEBOARD_CONFIG.appId;
let user = null;
let unsubStrokes = null;

function updateStatus(state, msg) {
    document.getElementById('status-text').innerText = msg;
    const dot = document.getElementById('status-dot');
    dot.className = 'w-2.5 h-2.5 rounded-full ' + (
        state === 'online' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse' :
            state === 'offline' ? 'bg-red-500' : 'bg-yellow-500'
    );
}

(async () => {
    try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token)
            await signInWithCustomToken(auth, __initial_auth_token);
        else
            await signInAnonymously(auth);
    } catch (e) { updateStatus('offline', 'Offline (Auth Failed)'); }
})();

// Once signed in, subscribe to the strokes collection. Every snapshot replaces the local
// `strokes` array wholesale (points are stored as a JSON string of [x,y] pairs to keep
// documents small; they're expanded back to {x,y} objects here).
onAuthStateChanged(auth, u => {
    user = u;
    if (u) {
        updateStatus('online', `Live (${u.uid.substring(0, 5)}...)`);
        if (unsubStrokes) unsubStrokes();
        const q = collection(db, 'artifacts', appId, 'public', 'data', 'strokes');
        unsubStrokes = onSnapshot(q, snap => {
            strokes = snap.docs.map(d => {
                const data = d.data();
                let pts = [];
                try { pts = typeof data.points === 'string' ? JSON.parse(data.points) : data.points; } catch (e) { }
                const normalizedPts = Array.isArray(pts) ? pts.map(p => Array.isArray(p) ? { x: p[0], y: p[1] } : p) : [];
                return { id: d.id, ...data, points: normalizedPts };
            });
            strokes.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

            // Lazily decode any image strokes we don't already have a bitmap for
            // (locally-pasted images are pre-seeded into imageCache at full quality —
            // see commitImageStroke — so this only fires for images from OTHER clients).
            const liveImageIds = new Set();
            for (const s of strokes) {
                if (s.type !== 'image') continue;
                liveImageIds.add(s.id);
                if (!s.src || imageCache.has(s.id)) continue;
                const im = new Image();
                im.onload = () => { offscreenDirty = true; isDirty = true; if (ui.tool === 'select') drawSelectionBox(); };
                im.src = s.src;
                imageCache.set(s.id, im);
            }
            for (const id of imageCache.keys()) if (!liveImageIds.has(id)) imageCache.delete(id);

            offscreenDirty = true;
            isDirty = true;
        }, () => updateStatus('offline', 'Sync Error'));
    } else {
        if (unsubStrokes) unsubStrokes();
        updateStatus('offline', 'Offline');
    }
});

// ─── DRAWING HELPERS ──────────────────────────────────────────────────────────
// All of these draw in WORLD coordinates; callers set up translate/scale on the ctx first.

// Drop points closer than `tol` to the previous kept point — smaller documents, same look.
function simplifyPoints(points, tol = 1.5) {
    if (points.length <= 2) return points;
    const out = [points[0]];
    let last = points[0];
    for (let i = 1; i < points.length - 1; i++) {
        const dx = points[i].x - last.x, dy = points[i].y - last.y;
        if (dx * dx + dy * dy > tol * tol) { out.push(points[i]); last = points[i]; }
    }
    out.push(points[points.length - 1]);
    return out;
}

// Pen strokes: quadratic curves through midpoints give a smooth line from raw pointer samples.
// isEraser switches to destination-out so the stroke punches transparency instead of painting.
function drawSmoothPath(ctx, points, color, thickness, isEraser) {
    if (!points || points.length === 0) return;
    ctx.beginPath();
    ctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 1) {
        ctx.arc(points[0].x, points[0].y, thickness / 2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        return;
    }
    if (points.length < 3) {
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    } else {
        for (let i = 1; i < points.length - 2; i++) {
            ctx.quadraticCurveTo(points[i].x, points[i].y, (points[i].x + points[i + 1].x) / 2, (points[i].y + points[i + 1].y) / 2);
        }
        ctx.quadraticCurveTo(points[points.length - 2].x, points[points.length - 2].y, points[points.length - 1].x, points[points.length - 1].y);
    }
    ctx.stroke();
}

function drawArrow(ctx, p1, p2, color, thickness) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color; ctx.lineWidth = thickness; ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const headLen = thickness * 4 + 5;
    ctx.beginPath();
    ctx.moveTo(p2.x, p2.y); ctx.lineTo(p2.x - headLen * Math.cos(angle - Math.PI / 6), p2.y - headLen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(p2.x, p2.y); ctx.lineTo(p2.x - headLen * Math.cos(angle + Math.PI / 6), p2.y - headLen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
}
function drawRect(ctx, p1, p2, color, thickness) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color; ctx.lineWidth = thickness; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.rect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y)); ctx.stroke();
}
function drawCircle(ctx, p1, p2, color, thickness) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color; ctx.lineWidth = thickness;
    ctx.beginPath(); ctx.ellipse((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, Math.abs(p2.x - p1.x) / 2, Math.abs(p2.y - p1.y) / 2, 0, 0, 2 * Math.PI); ctx.stroke();
}

// Dispatch by stroke.type. Add a branch here when adding a new tool.
function drawEntity(ctx, stroke) {
    if (!stroke.points || stroke.points.length === 0) return;
    if (stroke.type === 'pen' || stroke.type === 'eraser')
        drawSmoothPath(ctx, stroke.points, stroke.color, stroke.thickness, stroke.type === 'eraser');
    else if (stroke.type === 'arrow' && stroke.points.length > 1) drawArrow(ctx, stroke.points[0], stroke.points[1], stroke.color, stroke.thickness);
    else if (stroke.type === 'rect' && stroke.points.length > 1) drawRect(ctx, stroke.points[0], stroke.points[1], stroke.color, stroke.thickness);
    else if (stroke.type === 'circle' && stroke.points.length > 1) drawCircle(ctx, stroke.points[0], stroke.points[1], stroke.color, stroke.thickness);
    else if (stroke.type === 'image') {
        const img = imageCache.get(stroke.id);
        if (img && img.complete && img.naturalWidth) {
            ctx.drawImage(img, stroke.points[0].x, stroke.points[0].y, stroke.w, stroke.h);
        }
    }
    else if (stroke.type === 'text') {
        if (editing && editing.id === stroke.id) return; // the live editor is showing it instead
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = textFont(stroke.size);
        ctx.fillStyle = stroke.color || '#000';
        ctx.textBaseline = 'top';
        const lh = stroke.size * TEXT_LINE_HEIGHT;
        (stroke.text || '').split('\n').forEach((line, i) => ctx.fillText(line, stroke.points[0].x, stroke.points[0].y + i * lh));
    }
}

// ─── TEXT helpers ─────────────────────────────────────────────────────────────
const TEXT_LINE_HEIGHT = 1.25;
const textFont = size => `${size}px 'Segoe UI', system-ui, sans-serif`;
// Measure a text stroke's world-space box and store it on the stroke (w/h are also
// written to Firestore so other clients can hit-test without re-measuring).
function measureText(s) {
    offCtx.save(); offCtx.font = textFont(s.size);
    const lines = (s.text || '').split('\n');
    s.w = Math.max(20, ...lines.map(l => offCtx.measureText(l).width));
    s.h = Math.max(1, lines.length) * s.size * TEXT_LINE_HEIGHT;
    offCtx.restore();
}

// ─── OFFSCREEN / MAIN RENDER ──────────────────────────────────────────────────
// Rendering is lazy: renderLoop runs every animation frame but only repaints when
// isDirty is set. offscreen is only rebuilt when offscreenDirty is set or the view moved.
// Anything that changes strokes or the view must set isDirty (and usually offscreenDirty).

function rebuildOffscreen() {
    offCtx.clearRect(0, 0, offscreen.width, offscreen.height);
    offCtx.save();
    offCtx.translate(view.x, view.y);
    offCtx.scale(view.zoom, view.zoom);
    for (const stroke of strokes) drawEntity(offCtx, stroke);
    offCtx.restore();
    offscreenDirty = false;
    offscreenView = { x: view.x, y: view.y, zoom: view.zoom };
}

// Blit offscreen → main, then update the CSS dot grid to follow the view.
function redrawMain() {
    if (offscreenDirty) rebuildOffscreen();

    // If view changed since last offscreen render, we need to re-render
    if (offscreenView.x !== view.x || offscreenView.y !== view.y || offscreenView.zoom !== view.zoom) {
        rebuildOffscreen();
    }

    mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
    mainCtx.drawImage(offscreen, 0, 0, window.innerWidth, window.innerHeight);

    // Grid
    if (ui.showGrid && !ui.eink) {
        container.style.backgroundSize = `${40 * view.zoom}px ${40 * view.zoom}px`;
        container.style.backgroundPosition = `${view.x}px ${view.y}px`;
        container.style.backgroundImage = 'radial-gradient(#cbd5e1 1px, transparent 1px)';
    } else {
        container.style.backgroundImage = 'none';
    }

    // E-ink browsers (Boox) only refresh the panel when the page's layers change.
    // With the grid off nothing outside the canvas changes, so the committed stroke on
    // mainCanvas never got flushed while the overlay clear did — the line looked deleted.
    // Nudging a style on the container every redraw forces a composite.
    if (ui.eink) {
        einkFlip = !einkFlip;
        container.style.backgroundColor = einkFlip ? '#ffffff' : '#fefefe';
        mainCanvas.style.transform = einkFlip ? 'translateZ(0)' : 'none';
    }

    if (ui.tool === 'select') drawSelectionBox();
    if (editing) positionTextEditor();
    drawMinimap();
}
let einkFlip = false;

function renderLoop() {
    if (isDirty) { redrawMain(); isDirty = false; }
    requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// ─── INPUT ────────────────────────────────────────────────────────────────────
// All pointer handling is on overlayCanvas (the top canvas). Pointer Events unify
// mouse, touch and stylus; e.pointerType tells them apart.

// Screen (client) pixels → world coordinates.
function getCanvasPoint(clientX, clientY) {
    const rect = overlayCanvas.getBoundingClientRect();
    return { x: ((clientX - rect.left) - view.x) / view.zoom, y: ((clientY - rect.top) - view.y) / view.zoom };
}

function abortCurrentStroke() {
    isDrawing = false; currentStroke = null;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

// Stroke-erase hit test: returns true if point (cx, cy) in WORLD COORDS is within `radius` of any point in `stroke`
// Used by stroke-erase: is world point (cx,cy) within `radius` of this stroke?
// Pen strokes test every point AND every segment (so sparse straight lines still hit);
// shapes use a padded bounding box, which is good enough for a fat eraser.
function strokeHitTest(stroke, cx, cy, radius) {
    if (!stroke.points || stroke.points.length === 0) return false;
    const r2 = radius * radius;
    if (stroke.type === 'pen' || stroke.type === 'eraser') {
        for (const p of stroke.points) {
            if ((p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy) <= r2) return true;
        }
        // Also check segment midpoints for sparse strokes
        for (let i = 0; i < stroke.points.length - 1; i++) {
            const mx = (stroke.points[i].x + stroke.points[i + 1].x) / 2;
            const my = (stroke.points[i].y + stroke.points[i + 1].y) / 2;
            if ((mx - cx) * (mx - cx) + (my - cy) * (my - cy) <= r2) return true;
            // segment distance
            const dx = stroke.points[i + 1].x - stroke.points[i].x;
            const dy = stroke.points[i + 1].y - stroke.points[i].y;
            const len2 = dx * dx + dy * dy;
            if (len2 > 0) {
                let t = ((cx - stroke.points[i].x) * dx + (cy - stroke.points[i].y) * dy) / len2;
                t = Math.max(0, Math.min(1, t));
                const nx = stroke.points[i].x + t * dx - cx;
                const ny = stroke.points[i].y + t * dy - cy;
                if (nx * nx + ny * ny <= r2) return true;
            }
        }
    } else if (stroke.type === 'arrow' || stroke.type === 'rect' || stroke.type === 'circle') {
        // Simple bounding-box + endpoint check for shapes
        const [p1, p2] = stroke.points;
        if (!p2) return false;
        const minX = Math.min(p1.x, p2.x) - radius, maxX = Math.max(p1.x, p2.x) + radius;
        const minY = Math.min(p1.y, p2.y) - radius, maxY = Math.max(p1.y, p2.y) + radius;
        return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
    } else if (stroke.type === 'image' || stroke.type === 'text') {
        const p = stroke.points[0];
        const minX = p.x - radius, maxX = p.x + (stroke.w || 0) + radius;
        const minY = p.y - radius, maxY = p.y + (stroke.h || 0) + radius;
        return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
    }
    return false;
}

// Topmost image/text stroke whose bounding box contains world point (wx, wy). Used by the select tool.
function getObjectAt(wx, wy) {
    for (let i = strokes.length - 1; i >= 0; i--) {
        const s = strokes[i];
        if (s.type !== 'image' && s.type !== 'text') continue;
        const p = s.points[0];
        if (wx >= p.x && wx <= p.x + s.w && wy >= p.y && wy <= p.y + s.h) return s;
    }
    return null;
}

// Selection outline + resize handle for the currently-selected image, drawn on the overlay
// in SCREEN space (same convention as the live pen stroke drawn during a gesture).
function drawSelectionBox() {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (!selectedObjectId) return;
    const s = strokes.find(x => x.id === selectedObjectId && (x.type === 'image' || x.type === 'text'));
    if (!s) { selectedObjectId = null; return; }
    const x0 = s.points[0].x * view.zoom + view.x, y0 = s.points[0].y * view.zoom + view.y;
    const w0 = s.w * view.zoom, h0 = s.h * view.zoom;
    overlayCtx.save();
    overlayCtx.strokeStyle = '#2563eb'; overlayCtx.lineWidth = 2; overlayCtx.setLineDash([6, 4]);
    overlayCtx.strokeRect(x0, y0, w0, h0);
    overlayCtx.setLineDash([]);
    overlayCtx.fillStyle = '#2563eb';
    overlayCtx.fillRect(x0 + w0 - 9, y0 + h0 - 9, 18, 18);
    overlayCtx.restore();
}

// Small transient notice (e.g. "image too large to sync") — doesn't block input like alert().
function showToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
        position: 'fixed', bottom: '92px', left: '50%', transform: 'translateX(-50%)',
        background: '#0f172a', color: '#fff', padding: '8px 14px', borderRadius: '10px',
        fontSize: '13px', fontWeight: '600', zIndex: 60, boxShadow: '0 8px 30px rgba(0,0,0,.2)',
        maxWidth: '80vw', textAlign: 'center'
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2800);
}

// Right mouse button = temporary stroke eraser (restored on release)
let rightErase = null; // { tool, eraseMode } saved while right-button erasing
overlayCanvas.addEventListener('contextmenu', e => e.preventDefault());

// POINTER DOWN — decides what this gesture is:
//   right mouse → temporary stroke eraser
//   second finger → start pinch (abort any stroke)
//   single finger in 'pan' touch mode → pan
//   otherwise → start a stroke/shape/eraser/pan according to ui.tool
overlayCanvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button === 2 && activePointers.size === 0) {
        abortCurrentStroke();
        rightErase = { tool: ui.tool, eraseMode: ui.eraseMode };
        ui.tool = 'eraser'; ui.eraseMode = 'stroke';
    } else if (e.pointerType === 'mouse' && e.button !== 0) return;

    // Palm rejection: while a stylus is on the screen, ignore finger touches
    if (e.pointerType === 'touch' && [...activePointers.values()].some(p => p.pointerType === 'pen')) return;
    // A stylus landing while a finger stroke is in progress takes over
    if (e.pointerType === 'pen' && [...activePointers.values()].some(p => p.pointerType === 'touch')) {
        abortCurrentStroke(); isPanning = false; activePointers.clear(); initialPinchDistance = null;
    }

    overlayCanvas.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, e);

    // Finger-pans mode: a single finger pans, any tool; stylus/mouse still draw
    if (e.pointerType === 'touch' && ui.touchMode === 'pan' && activePointers.size === 1) {
        isPanning = true; lastPt = { x: e.clientX, y: e.clientY }; return;
    }

    if (activePointers.size === 2) {
        abortCurrentStroke(); isPanning = false;
        const pts = Array.from(activePointers.values());
        initialPinchDistance = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
        initialPinchCenter = { x: (pts[0].clientX + pts[1].clientX) / 2, y: (pts[0].clientY + pts[1].clientY) / 2 };
        initialView = { ...view };
        return;
    }

    if (activePointers.size === 1) {
        const shapeTools = ['pen', 'arrow', 'rect', 'circle'];
        if (shapeTools.includes(ui.tool) || (ui.tool === 'eraser' && ui.eraseMode === 'partial')) {
            isDrawing = true;
            const pt = getCanvasPoint(e.clientX, e.clientY);
            currentStroke = {
                id: crypto.randomUUID(),
                type: ui.tool === 'eraser' ? 'eraser' : ui.tool,
                color: ui.color, thickness: ui.thickness, points: [pt]
            };
            lastPt = { ...pt };
            if (ui.tool === 'pen') {
                // Draw dot immediately
                overlayCtx.beginPath();
                overlayCtx.arc(pt.x * view.zoom + view.x, pt.y * view.zoom + view.y, (ui.thickness * view.zoom) / 2, 0, Math.PI * 2);
                overlayCtx.fillStyle = ui.color; overlayCtx.fill();
            }
        } else if (ui.tool === 'eraser' && ui.eraseMode === 'stroke') {
            isDrawing = true;
            erasedThisGesture.clear();
            lastPt = getCanvasPoint(e.clientX, e.clientY);
            // Immediate hit on down
            eraseStrokesAtPoint(lastPt.x, lastPt.y);
        } else if (ui.tool === 'pan') {
            isPanning = true;
            lastPt = { x: e.clientX, y: e.clientY };
            overlayCanvas.style.cursor = 'grabbing';
        } else if (ui.tool === 'text') {
            // Click on empty space → new text; click on existing text → edit it.
            if (editing) { commitTextEdit(); return; }
            const wp = getCanvasPoint(e.clientX, e.clientY);
            const hit = getObjectAt(wp.x, wp.y);
            if (hit && hit.type === 'text') openTextEditor(hit);
            else openTextEditor(null, wp);
        } else if (ui.tool === 'select') {
            if (editing) commitTextEdit();
            const wp = getCanvasPoint(e.clientX, e.clientY);
            objectDrag = null;
            // Resize handle takes priority when an image is already selected
            if (selectedObjectId) {
                const sel = strokes.find(s => s.id === selectedObjectId && (s.type === 'image' || s.type === 'text'));
                if (sel) {
                    const hx = sel.points[0].x * view.zoom + view.x + sel.w * view.zoom;
                    const hy = sel.points[0].y * view.zoom + view.y + sel.h * view.zoom;
                    const dx = e.clientX - hx, dy = e.clientY - hy;
                    if (dx * dx + dy * dy <= 22 * 22) {
                        objectDrag = { id: sel.id, mode: 'resize', orig: { x: sel.points[0].x, y: sel.points[0].y, w: sel.w, h: sel.h, size: sel.size }, startWx: wp.x, startWy: wp.y };
                    }
                }
            }
            if (!objectDrag) {
                const hit = getObjectAt(wp.x, wp.y);
                if (hit) {
                    selectedObjectId = hit.id;
                    objectDrag = { id: hit.id, mode: 'move', orig: { x: hit.points[0].x, y: hit.points[0].y, w: hit.w, h: hit.h, size: hit.size }, startWx: wp.x, startWy: wp.y };
                } else {
                    selectedObjectId = null;
                }
            }
            drawSelectionBox();
        }
    }
});

// Stroke-erase hit: remove every stroke under the eraser (optimistic local delete + Firestore
// delete + undo entry). erasedThisGesture stops re-deleting during one drag.
function eraseStrokesAtPoint(wx, wy) {
    const radius = (ui.thickness * 8) / view.zoom; // eraser radius in world space
    const toErase = strokes.filter(s => !erasedThisGesture.has(s.id) && strokeHitTest(s, wx, wy, radius));
    if (toErase.length === 0) return;

    const ids = toErase.map(s => s.id);
    ids.forEach(id => erasedThisGesture.add(id));

    // Optimistic local update
    const erasedStrokes = strokes.filter(s => ids.includes(s.id));
    strokes = strokes.filter(s => !ids.includes(s.id));
    offscreenDirty = true; isDirty = true;

    // Push to undo stack
    undoStack.push({ type: 'delete', strokes: erasedStrokes });

    // Firestore delete
    if (user) {
        ids.forEach(id => deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'strokes', id)).catch(() => { }));
    }
}

// POINTER MOVE — hot path, keep it cheap.
//   pinch → recompute view.zoom/x/y from the two fingers, full re-render
//   stroke-erase → hit-test each coalesced point, draw a cursor circle on the overlay
//   shape tools → update the 2nd point and redraw only the shape on the overlay
//   partial eraser → paint destination-out directly on mainCanvas (offscreen catches up on commit)
//   pen → append points and draw only the NEW segments onto the overlay (no re-render)
//   pan → shift view by the mouse delta
// getCoalescedEvents() returns all the high-frequency samples since the last event
// (stylus can report 240Hz), so curves don't look chunky at 60fps.
overlayCanvas.addEventListener('pointermove', e => {
    if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, e);

    // Select tool: dragging an image (move or resize)
    if (objectDrag) {
        const wp = getCanvasPoint(e.clientX, e.clientY);
        const s = strokes.find(x => x.id === objectDrag.id);
        if (s) {
            if (objectDrag.mode === 'move') {
                s.points[0] = { x: objectDrag.orig.x + (wp.x - objectDrag.startWx), y: objectDrag.orig.y + (wp.y - objectDrag.startWy) };
            } else if (s.type === 'text') {
                // Text resizes by font size: the handle's vertical drag sets the scale, width follows the text.
                const scale = Math.max(0.2, (objectDrag.orig.h + (wp.y - objectDrag.startWy)) / objectDrag.orig.h);
                s.size = Math.max(6, Math.round(objectDrag.orig.size * scale * 10) / 10);
                measureText(s);
            } else {
                const minSize = 20 / view.zoom;
                s.w = Math.max(minSize, objectDrag.orig.w + (wp.x - objectDrag.startWx));
                s.h = Math.max(minSize, objectDrag.orig.h + (wp.y - objectDrag.startWy));
            }
            offscreenDirty = true; isDirty = true;
            drawSelectionBox();
        }
        return;
    }

    // Pinch zoom/pan
    if (activePointers.size === 2 && initialPinchDistance) {
        const pts = Array.from(activePointers.values());
        const curCenter = { x: (pts[0].clientX + pts[1].clientX) / 2, y: (pts[0].clientY + pts[1].clientY) / 2 };
        const dist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
        view.zoom = Math.min(Math.max(0.1, initialView.zoom * (dist / initialPinchDistance)), 10);
        const worldX = (initialPinchCenter.x - initialView.x) / initialView.zoom;
        const worldY = (initialPinchCenter.y - initialView.y) / initialView.zoom;
        view.x = curCenter.x - worldX * view.zoom;
        view.y = curCenter.y - worldY * view.zoom;
        offscreenDirty = true; isDirty = true; updateZoomUI();
        return;
    }

    if (ui.tool === 'eraser' && ui.eraseMode === 'stroke' && isDrawing) {
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        const lastEv = events[events.length - 1];
        for (const ev of events) {
            const pt = getCanvasPoint(ev.clientX, ev.clientY);
            eraseStrokesAtPoint(pt.x, pt.y);
        }
        // Draw eraser cursor only for last position (avoid redundant clears)
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        const screenR = ui.thickness * 8;
        overlayCtx.beginPath();
        overlayCtx.arc(lastEv.clientX, lastEv.clientY, screenR, 0, Math.PI * 2);
        overlayCtx.strokeStyle = 'rgba(100,100,100,0.4)';
        overlayCtx.lineWidth = 1.5;
        overlayCtx.stroke();
        return;
    }

    if (isDrawing && currentStroke) {
        if (['arrow', 'rect', 'circle'].includes(ui.tool)) {
            currentStroke.points[1] = getCanvasPoint(e.clientX, e.clientY);
            overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
            overlayCtx.save();
            overlayCtx.translate(view.x, view.y); overlayCtx.scale(view.zoom, view.zoom);
            drawEntity(overlayCtx, currentStroke);
            overlayCtx.restore();
        } else {
            // Use coalesced events for pen and partial eraser
            const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];

            if (ui.tool === 'eraser') {
                // Partial eraser: batch all coalesced points into one draw call
                mainCtx.save();
                mainCtx.translate(view.x, view.y); mainCtx.scale(view.zoom, view.zoom);
                mainCtx.globalCompositeOperation = 'destination-out';
                mainCtx.beginPath();
                mainCtx.moveTo(lastPt.x, lastPt.y);
                mainCtx.lineWidth = currentStroke.thickness;
                mainCtx.lineCap = mainCtx.lineJoin = 'round';
                for (const ev of events) {
                    const pt = getCanvasPoint(ev.clientX, ev.clientY);
                    currentStroke.points.push(pt);
                    mainCtx.lineTo(pt.x, pt.y);
                    lastPt = pt;
                }
                mainCtx.stroke();
                mainCtx.restore();
            } else {
                // Pen: batch coalesced points into single path, skip micro-moves
                overlayCtx.beginPath();
                overlayCtx.strokeStyle = currentStroke.color;
                overlayCtx.lineWidth = currentStroke.thickness * view.zoom;
                overlayCtx.lineCap = overlayCtx.lineJoin = 'round';
                overlayCtx.moveTo(lastPt.x * view.zoom + view.x, lastPt.y * view.zoom + view.y);
                for (const ev of events) {
                    const pt = getCanvasPoint(ev.clientX, ev.clientY);
                    // Skip point if too close (reduces array size & draw calls)
                    const dx = pt.x - lastPt.x, dy = pt.y - lastPt.y;
                    if (dx * dx + dy * dy < MIN_DRAW_DIST_SQ) continue;
                    currentStroke.points.push(pt);
                    overlayCtx.lineTo(pt.x * view.zoom + view.x, pt.y * view.zoom + view.y);
                    lastPt = pt;
                }
                overlayCtx.stroke();
            }

            // Chunk long strokes (lower threshold for responsiveness)
            if (currentStroke.points.length >= 150) {
                const tail = currentStroke.points[currentStroke.points.length - 1];
                commitStroke(true);
                currentStroke = { id: crypto.randomUUID(), type: ui.tool === 'eraser' ? 'eraser' : ui.tool, color: ui.color, thickness: ui.thickness, points: [{ ...tail }] };
            }
        }
    } else if (isPanning) {
        view.x += e.clientX - lastPt.x; view.y += e.clientY - lastPt.y;
        lastPt = { x: e.clientX, y: e.clientY };
        offscreenDirty = true; isDirty = true; updateZoomUI();
    }
});

// COMMIT — the in-progress stroke becomes real: simplified, pushed to `strokes`, pushed
// to the undo stack, written to Firestore (deferred with setTimeout so the write never
// blocks the pointer thread). keepDrawing=true is the mid-stroke chunking case: the
// current chunk is committed and a new one continues from its last point.
async function commitStroke(keepDrawing = false) {
    if (isDrawing && currentStroke && currentStroke.points.length > 0) {
        if (['arrow', 'rect', 'circle'].includes(currentStroke.type) && currentStroke.points.length < 2) {
            if (!keepDrawing) abortCurrentStroke(); return;
        }
        if (['pen', 'eraser'].includes(currentStroke.type)) currentStroke.points = simplifyPoints(currentStroke.points, 1.5);

        const s = { ...currentStroke };
        strokes.push(s);
        undoStack.push({ type: 'add', strokes: [s] }); // track for undo
        offscreenDirty = true; isDirty = true;

        if (user) {
            const payload = {
                type: s.type, color: s.color, thickness: s.thickness,
                points: JSON.stringify(s.points.map(p => [+p.x.toFixed(1), +p.y.toFixed(1)])),
                timestamp: Date.now()
            };
            // Defer write with setTimeout to prevent blocking drawing thread (readded optimization)
            setTimeout(() => {
                setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'strokes', s.id), payload)
                    .catch(e => console.error("Firebase write error:", e));
            }, 0);
        }
    }
    if (!keepDrawing) abortCurrentStroke();
    else { rebuildOffscreen(); overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height); isDirty = true; }
}

// ─── IMAGE PASTE ──────────────────────────────────────────────────────────────
// Images reuse the strokes collection (type:'image') so sync/undo/erase/clear are free.
// Firestore caps a document around 1MB; compressImageToDataURL() downscales/re-encodes
// until the base64 payload fits a safe budget, trying progressively smaller settings.
function writeObjectDoc(s) {
    if (!user) return;
    const base = {
        type: s.type,
        points: JSON.stringify([[+s.points[0].x.toFixed(1), +s.points[0].y.toFixed(1)]]),
        w: s.w, h: s.h, timestamp: s.timestamp || Date.now()
    };
    const payload = s.type === 'text'
        ? { ...base, text: s.text, color: s.color, size: s.size }
        : { ...base, src: s.src };
    setTimeout(() => {
        setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'strokes', s.id), payload)
            .catch(e => console.error('Firebase write error:', e));
    }, 0);
}

// ─── TEXT TOOL editor ─────────────────────────────────────────────────────────
// A single <textarea> is reused. openTextEditor(existing) edits a stroke in place (the
// canvas stops drawing that stroke while the editor covers it); openTextEditor(null, wp)
// starts a new one at world point wp. Commit on click-away / Ctrl+Enter, cancel on Escape.
function openTextEditor(existing, wp) {
    if (editing) commitTextEdit();
    const size = existing ? existing.size : Math.max(14, 16 + ui.thickness * 2);
    editing = existing
        ? { id: existing.id, x: existing.points[0].x, y: existing.points[0].y, size, color: existing.color, isNew: false, before: { text: existing.text, size: existing.size, w: existing.w, h: existing.h, points: [{ ...existing.points[0] }] } }
        : { id: crypto.randomUUID(), x: wp.x, y: wp.y, size, color: ui.color, isNew: true };
    textEditor.value = existing ? existing.text : '';
    textEditor.classList.add('open');
    positionTextEditor();
    offscreenDirty = true; isDirty = true; // hide the canvas copy of the text being edited
    selectedObjectId = null; drawSelectionBox();
    setTimeout(() => { textEditor.focus(); if (existing) textEditor.select(); }, 0);
}
function positionTextEditor() {
    if (!editing) return;
    const px = editing.size * view.zoom;
    textEditor.style.left = (editing.x * view.zoom + view.x - 6) + 'px';
    textEditor.style.top = (editing.y * view.zoom + view.y - 4) + 'px';
    textEditor.style.fontSize = px + 'px';
    textEditor.style.color = editing.color;
    autosizeTextEditor();
}
function autosizeTextEditor() {
    const lines = textEditor.value.split('\n');
    textEditor.rows = Math.max(1, lines.length);
    offCtx.save(); offCtx.font = textFont(editing.size * view.zoom);
    const w = Math.max(...lines.map(l => offCtx.measureText(l).width), 40);
    offCtx.restore();
    textEditor.style.width = (w + 16) + 'px';
}
function commitTextEdit() {
    if (!editing) return;
    const ed = editing; editing = null;
    textEditor.classList.remove('open');
    const text = textEditor.value.replace(/\s+$/, '');
    if (ed.isNew) {
        if (text.trim()) {
            const s = { id: ed.id, type: 'text', text, color: ed.color, size: ed.size, points: [{ x: ed.x, y: ed.y }], timestamp: Date.now() };
            measureText(s);
            strokes.push(s);
            undoStack.push({ type: 'add', strokes: [s] });
            writeObjectDoc(s);
        }
    } else {
        const s = strokes.find(x => x.id === ed.id);
        if (s) {
            if (!text.trim()) {
                strokes = strokes.filter(x => x.id !== s.id);
                undoStack.push({ type: 'delete', strokes: [s] });
                if (user) deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'strokes', s.id)).catch(() => { });
            } else if (text !== s.text) {
                s.text = text; measureText(s);
                undoStack.push({ type: 'update', id: s.id, before: ed.before, after: { text: s.text, size: s.size, w: s.w, h: s.h, points: [{ ...s.points[0] }] } });
                writeObjectDoc(s);
            }
        }
    }
    offscreenDirty = true; isDirty = true;
}
function cancelTextEdit() {
    if (!editing) return;
    editing = null; textEditor.classList.remove('open');
    offscreenDirty = true; isDirty = true;
}
textEditor.addEventListener('input', autosizeTextEditor);
textEditor.addEventListener('keydown', e => {
    e.stopPropagation(); // keep Space/Delete/Ctrl+Z from reaching the board shortcuts
    if (e.key === 'Escape') { e.preventDefault(); cancelTextEdit(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitTextEdit(); }
});
textEditor.addEventListener('blur', () => { if (editing) commitTextEdit(); });
// Stop pointer events inside the editor from starting a stroke on the canvas beneath
['pointerdown', 'pointermove', 'pointerup', 'wheel'].forEach(ev => textEditor.addEventListener(ev, e => e.stopPropagation()));

function commitImageStroke(s, oversized) {
    strokes.push(s);
    undoStack.push({ type: 'add', strokes: [s] });
    offscreenDirty = true; isDirty = true;
    if (oversized) showToast('That image is very large — it\'s on your board, but it won\'t sync to other devices.');
    else writeObjectDoc(s);
}

function loadImageBlob(blob) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image')); };
        img.src = url;
    });
}

// Downscale + re-encode until the data URL fits under `budget` chars, trying progressively
// smaller max dimensions and JPEG qualities. Returns the smallest attempt (flagged
// oversized:true) if nothing fits, so the caller can still show it locally.
function compressImageToDataURL(img, budget = 700000) {
    const dims = [1920, 1600, 1200, 900, 600];
    const qualities = [0.85, 0.7, 0.55, 0.4];
    let smallest = null;
    for (const maxDim of dims) {
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        for (const q of qualities) {
            const dataURL = c.toDataURL('image/jpeg', q);
            if (!smallest || dataURL.length < smallest.dataURL.length) smallest = { dataURL };
            if (dataURL.length <= budget) return { dataURL, oversized: false };
        }
    }
    return { dataURL: smallest.dataURL, oversized: true };
}

// Shared by paste and drag-and-drop: place `blob` centered on (screenX, screenY),
// sized to a comfortable on-screen footprint while preserving aspect ratio.
async function insertImageBlob(blob, screenX, screenY) {
    let img;
    try { img = await loadImageBlob(blob); } catch (e) { console.error('Image paste failed:', e); return; }

    const maxScreenDim = Math.min(480, window.innerWidth * 0.6, window.innerHeight * 0.6);
    const aspect = img.naturalWidth / img.naturalHeight || 1;
    let screenW = Math.min(maxScreenDim, img.naturalWidth), screenH = screenW / aspect;
    if (screenH > maxScreenDim) { screenH = maxScreenDim; screenW = screenH * aspect; }
    const worldW = screenW / view.zoom, worldH = screenH / view.zoom;
    const center = getCanvasPoint(screenX, screenY);

    const { dataURL, oversized } = compressImageToDataURL(img);
    const id = crypto.randomUUID();
    const stroke = {
        id, type: 'image', src: dataURL, timestamp: Date.now(),
        points: [{ x: center.x - worldW / 2, y: center.y - worldH / 2 }],
        w: worldW, h: worldH
    };
    imageCache.set(id, img); // keep the full-quality decoded bitmap for OUR local rendering
    commitImageStroke(stroke, oversized);
    switchTool('select'); selectedObjectId = id; drawSelectionBox();
}

// Ctrl/Cmd+V — only intercepted when the clipboard actually holds image data, so pasting
// text into a widget's own input/textarea is completely unaffected.
window.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items; if (!items) return;
    let imageItem = null;
    for (const item of items) { if (item.type && item.type.startsWith('image/')) { imageItem = item; break; } }
    if (!imageItem) return;
    e.preventDefault();
    const blob = imageItem.getAsFile(); if (!blob) return;
    insertImageBlob(blob, window.innerWidth / 2, window.innerHeight / 2);
});

// Drag-and-drop an image file onto the board, dropped at the cursor position.
container.addEventListener('dragover', e => { if ([...(e.dataTransfer?.items || [])].some(i => i.type.startsWith('image/'))) e.preventDefault(); });
container.addEventListener('drop', e => {
    const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    insertImageBlob(file, e.clientX, e.clientY);
});

overlayCanvas.addEventListener('pointerup', e => {
    activePointers.delete(e.pointerId);
    overlayCanvas.releasePointerCapture(e.pointerId);

    if (objectDrag) {
        const s = strokes.find(x => x.id === objectDrag.id);
        if (s) {
            const before = { points: [{ x: objectDrag.orig.x, y: objectDrag.orig.y }], w: objectDrag.orig.w, h: objectDrag.orig.h, size: objectDrag.orig.size };
            const after = { points: [{ x: s.points[0].x, y: s.points[0].y }], w: s.w, h: s.h, size: s.size };
            const changed = before.points[0].x !== after.points[0].x || before.points[0].y !== after.points[0].y || before.w !== after.w || before.h !== after.h || before.size !== after.size;
            if (changed) {
                undoStack.push({ type: 'update', id: s.id, before, after });
                writeObjectDoc(s);
            }
        }
        objectDrag = null;
        return;
    }

    if (activePointers.size < 2) initialPinchDistance = null;
    if (activePointers.size === 0) {
        if (ui.tool === 'eraser' && ui.eraseMode === 'stroke') {
            isDrawing = false;
            overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        } else {
            commitStroke();
        }
        isPanning = false; endRightErase(); updateCursor();
    }
});

function endRightErase() {
    if (!rightErase) return;
    ui.tool = rightErase.tool; ui.eraseMode = rightErase.eraseMode; rightErase = null;
    updateUI();
}

overlayCanvas.addEventListener('pointercancel', e => {
    activePointers.delete(e.pointerId);
    overlayCanvas.releasePointerCapture(e.pointerId);
    if (activePointers.size === 0) { abortCurrentStroke(); isPanning = false; endRightErase(); updateCursor(); }
});

// Wheel zoom around the cursor: keep the world point under the mouse fixed while scaling.
overlayCanvas.addEventListener('wheel', e => {
    e.preventDefault();
    const newZoom = Math.min(Math.max(0.1, view.zoom * (1 + (-e.deltaY * 0.001))), 10);
    const rect = overlayCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const wx = (mx - view.x) / view.zoom, wy = (my - view.y) / view.zoom;
    view.zoom = newZoom; view.x = mx - wx * view.zoom; view.y = my - wy * view.zoom;
    offscreenDirty = true; isDirty = true; updateZoomUI();
}, { passive: false });

// ─── UNDO ─────────────────────────────────────────────────────────────────────
// Single-level history stack (no redo). Undo of an 'add' deletes docs; undo of a
// 'delete' (erase or Clear) re-creates them with their original ids and timestamps.
async function undo() {
    if (undoStack.length === 0) return;
    const action = undoStack.pop();

    if (action.type === 'add') {
        // Remove the added strokes
        const ids = action.strokes.map(s => s.id);
        strokes = strokes.filter(s => !ids.includes(s.id));
        if (user) ids.forEach(id => deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'strokes', id)).catch(() => { }));
    } else if (action.type === 'delete') {
        // Re-add the deleted strokes
        for (const s of action.strokes) {
            strokes.push(s);
            if (s.type === 'image' || s.type === 'text') {
                if (s.type === 'image' && !imageCache.has(s.id) && s.src) {
                    const im = new Image(); im.onload = () => { offscreenDirty = true; isDirty = true; }; im.src = s.src;
                    imageCache.set(s.id, im);
                }
                writeObjectDoc(s);
            } else if (user) {
                const payload = {
                    type: s.type, color: s.color, thickness: s.thickness,
                    points: JSON.stringify(s.points.map(p => [+p.x.toFixed(1), +p.y.toFixed(1)])), timestamp: s.timestamp || Date.now()
                };
                setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'strokes', s.id), payload).catch(() => { });
            }
        }
        strokes.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    } else if (action.type === 'update') {
        // Image/text move, resize or text edit: restore the "before" state
        const s = strokes.find(x => x.id === action.id);
        if (s) {
            const b = action.before;
            s.points = [{ ...b.points[0] }]; s.w = b.w; s.h = b.h;
            if (b.size !== undefined) s.size = b.size;
            if (b.text !== undefined) s.text = b.text;
            writeObjectDoc(s);
        }
    }
    offscreenDirty = true; isDirty = true;
    if (ui.tool === 'select') drawSelectionBox();
}

// ─── UI / TOOLBAR ─────────────────────────────────────────────────────────────
// updateUI() is the single place that syncs the DOM to `ui`: active tool button, grid
// button, eraser sub-options, active color swatch, cursor. Call it after changing ui.*.
function updateZoomUI() {
    document.getElementById('btn-zoom-reset').innerText = `${Math.round(view.zoom * 100)}%`;
}
function applyZoomDelta(delta) {
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const wx = (cx - view.x) / view.zoom, wy = (cy - view.y) / view.zoom;
    view.zoom = Math.min(Math.max(0.1, view.zoom * delta), 10);
    view.x = cx - wx * view.zoom; view.y = cy - wy * view.zoom;
    offscreenDirty = true; isDirty = true; updateZoomUI();
}
document.getElementById('btn-zoom-in').onclick = () => applyZoomDelta(1.25);
document.getElementById('btn-zoom-out').onclick = () => applyZoomDelta(0.8);
document.getElementById('btn-zoom-reset').onclick = () => { view.zoom = 1; view.x = 0; view.y = 0; offscreenDirty = true; isDirty = true; updateZoomUI(); };

// Jump to blank space: move right along the top row (world y = 0) so the left edge of the
// screen sits just past the right-most thing currently drawn in the top row of what you
// can see (JUMP_GAP world px after it). If the new view still contains something, keep
// nudging right until it's clear. If nothing is in view, step one full screen. This keeps
// pages tight — no wasted half-screens between them.
const JUMP_GAP = 40;
function strokeBounds(s) {
    const p0 = s.points[0];
    if (s.type === 'image' || s.type === 'text') return { minX: p0.x, minY: p0.y, maxX: p0.x + (s.w || 0), maxY: p0.y + (s.h || 0) };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of s.points) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
    const t = s.thickness || 0;
    return { minX: minX - t, minY: minY - t, maxX: maxX + t, maxY: maxY + t };
}
function jumpToBlankSpace() {
    abortCurrentStroke();
    const pageW = window.innerWidth / view.zoom, pageH = window.innerHeight / view.zoom;
    // Right-most content edge inside the top-row band [x0, x0+pageW), or null if empty
    const rightmostIn = x0 => {
        let mx = null;
        for (const s of strokes) {
            if (s.type === 'eraser' || !s.points.length) continue;
            const b = strokeBounds(s);
            if (b.maxX > x0 && b.minX < x0 + pageW && b.maxY > 0 && b.minY < pageH) mx = Math.max(mx ?? -Infinity, b.maxX);
        }
        return mx;
    };
    let left = -view.x / view.zoom;
    let mx = rightmostIn(left);
    if (mx === null) left += pageW;                 // nothing in view: step a full screen
    else left = mx + JUMP_GAP;                      // otherwise land just past the last thing
    for (let i = 0; i < 50; i++) {                  // and keep nudging until the new view is clear
        const m2 = rightmostIn(left);
        if (m2 === null) break;
        left = m2 + JUMP_GAP;
    }
    view.x = -left * view.zoom;
    view.y = 0;
    offscreenDirty = true; isDirty = true; updateZoomUI();
}
document.getElementById('btn-blank').onclick = jumpToBlankSpace;

// ─── MINIMAP ──────────────────────────────────────────────────────────────────
// A 200×130 canvas showing the union of all content + the current viewport, redrawn from
// redrawMain() (throttled — it's a full pass over `strokes`, so pen strokes are sampled
// down to ~40 points each). mmMap is the world→minimap transform of the last draw, used
// to turn clicks back into world coordinates. Toggle persisted in localStorage.
const minimap = document.getElementById('minimap');
const mmCtx = minimap.getContext('2d');
const MM_W = 200, MM_H = 130;
let mmMap = null, mmLast = 0, mmTimer = null;
ui.minimap = localStorage.getItem('whiteboard.minimap') !== '0';

function resizeMinimap() {
    const d = Math.min(window.devicePixelRatio || 1, 2);
    minimap.width = MM_W * d; minimap.height = MM_H * d;
    mmCtx.setTransform(d, 0, 0, d, 0, 0);
}
resizeMinimap();
window.addEventListener('resize', resizeMinimap);

// World-space bounding box of everything drawn, or null for an empty board.
function contentBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) {
        if (s.type === 'eraser') continue;
        if (s.type === 'image' || s.type === 'text') {
            const p = s.points[0];
            minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x + (s.w || 0)); maxY = Math.max(maxY, p.y + (s.h || 0));
        } else {
            for (const p of s.points) {
                if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
            }
        }
    }
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

function drawMinimap() {
    if (!ui.minimap) return;
    const now = performance.now();
    if (now - mmLast < 80) { clearTimeout(mmTimer); mmTimer = setTimeout(drawMinimap, 90); return; }
    mmLast = now;

    // Region to show = content ∪ viewport, padded 8%
    const vp = { minX: -view.x / view.zoom, minY: -view.y / view.zoom };
    vp.maxX = vp.minX + window.innerWidth / view.zoom; vp.maxY = vp.minY + window.innerHeight / view.zoom;
    const cb = contentBounds() || vp;
    let minX = Math.min(cb.minX, vp.minX), minY = Math.min(cb.minY, vp.minY);
    let maxX = Math.max(cb.maxX, vp.maxX), maxY = Math.max(cb.maxY, vp.maxY);
    const padX = (maxX - minX) * 0.08 || 50, padY = (maxY - minY) * 0.08 || 50;
    minX -= padX; maxX += padX; minY -= padY; maxY += padY;
    const scale = Math.min(MM_W / (maxX - minX), MM_H / (maxY - minY));
    const ox = (MM_W - (maxX - minX) * scale) / 2 - minX * scale;
    const oy = (MM_H - (maxY - minY) * scale) / 2 - minY * scale;
    mmMap = { scale, ox, oy };
    const X = x => x * scale + ox, Y = y => y * scale + oy;

    mmCtx.clearRect(0, 0, MM_W, MM_H);
    mmCtx.lineCap = mmCtx.lineJoin = 'round';
    for (const s of strokes) {
        if (s.type === 'eraser' || !s.points.length) continue;
        const p0 = s.points[0];
        if (s.type === 'image') { mmCtx.fillStyle = ui.eink ? '#888' : '#cbd5e1'; mmCtx.fillRect(X(p0.x), Y(p0.y), Math.max(1, s.w * scale), Math.max(1, s.h * scale)); }
        else if (s.type === 'text') { mmCtx.fillStyle = s.color || '#000'; mmCtx.globalAlpha = .45; mmCtx.fillRect(X(p0.x), Y(p0.y), Math.max(1, s.w * scale), Math.max(1, s.h * scale)); mmCtx.globalAlpha = 1; }
        else if (s.type === 'rect' && s.points[1]) { mmCtx.strokeStyle = s.color; mmCtx.lineWidth = 1; const p1 = s.points[1]; mmCtx.strokeRect(X(Math.min(p0.x, p1.x)), Y(Math.min(p0.y, p1.y)), Math.abs(p1.x - p0.x) * scale, Math.abs(p1.y - p0.y) * scale); }
        else if ((s.type === 'arrow' || s.type === 'circle') && s.points[1]) { mmCtx.strokeStyle = s.color; mmCtx.lineWidth = 1; mmCtx.beginPath(); mmCtx.moveTo(X(p0.x), Y(p0.y)); mmCtx.lineTo(X(s.points[1].x), Y(s.points[1].y)); mmCtx.stroke(); }
        else {
            mmCtx.strokeStyle = s.color; mmCtx.lineWidth = Math.max(1, Math.min(3, s.thickness * scale));
            const step = Math.max(1, Math.floor(s.points.length / 40));
            mmCtx.beginPath(); mmCtx.moveTo(X(p0.x), Y(p0.y));
            for (let i = step; i < s.points.length; i += step) mmCtx.lineTo(X(s.points[i].x), Y(s.points[i].y));
            const last = s.points[s.points.length - 1]; mmCtx.lineTo(X(last.x), Y(last.y));
            mmCtx.stroke();
        }
    }
    // Viewport
    mmCtx.fillStyle = ui.eink ? 'rgba(0,0,0,0.08)' : 'rgba(37,99,235,0.10)';
    mmCtx.strokeStyle = ui.eink ? '#000' : '#2563eb'; mmCtx.lineWidth = 1.5;
    const vx = X(vp.minX), vy = Y(vp.minY), vw = (vp.maxX - vp.minX) * scale, vh = (vp.maxY - vp.minY) * scale;
    mmCtx.fillRect(vx, vy, vw, vh); mmCtx.strokeRect(vx, vy, vw, vh);
}

// Click / drag on the minimap → center the view on that world point
function minimapJump(e) {
    if (!mmMap) return;
    const r = minimap.getBoundingClientRect();
    const wx = (e.clientX - r.left - mmMap.ox) / mmMap.scale, wy = (e.clientY - r.top - mmMap.oy) / mmMap.scale;
    view.x = window.innerWidth / 2 - wx * view.zoom; view.y = window.innerHeight / 2 - wy * view.zoom;
    offscreenDirty = true; isDirty = true; updateZoomUI();
}
minimap.addEventListener('pointerdown', e => {
    e.preventDefault(); minimap.setPointerCapture(e.pointerId); minimapJump(e);
    const move = ev => minimapJump(ev);
    const up = () => { minimap.removeEventListener('pointermove', move); minimap.removeEventListener('pointerup', up); minimap.removeEventListener('pointercancel', up); };
    minimap.addEventListener('pointermove', move); minimap.addEventListener('pointerup', up); minimap.addEventListener('pointercancel', up);
});
// Double-click → zoom to fit all content
function fitToContent() {
    const b = contentBounds(); if (!b) { view.zoom = 1; view.x = 0; view.y = 0; }
    else {
        const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
        view.zoom = Math.min(Math.max(0.1, Math.min((window.innerWidth - 120) / bw, (window.innerHeight - 200) / bh)), 10);
        view.x = window.innerWidth / 2 - (b.minX + bw / 2) * view.zoom;
        view.y = window.innerHeight / 2 - (b.minY + bh / 2) * view.zoom;
    }
    offscreenDirty = true; isDirty = true; updateZoomUI();
}
minimap.addEventListener('dblclick', fitToContent);

function applyMinimap() {
    document.body.classList.toggle('minimap-off', !ui.minimap);
    const b = document.getElementById('btn-minimap');
    b.classList.toggle('text-blue-600', ui.minimap); b.classList.toggle('bg-blue-50', ui.minimap);
    b.classList.toggle('text-gray-600', !ui.minimap);
    if (ui.minimap) { mmLast = 0; drawMinimap(); }
}
document.getElementById('btn-minimap').onclick = () => {
    ui.minimap = !ui.minimap; localStorage.setItem('whiteboard.minimap', ui.minimap ? '1' : '0'); applyMinimap();
};
applyMinimap();

function updateCursor() {
    if (ui.tool === 'pan') overlayCanvas.style.cursor = isPanning ? 'grabbing' : 'grab';
    else if (ui.tool === 'eraser') overlayCanvas.style.cursor = 'cell';
    else if (ui.tool === 'select') overlayCanvas.style.cursor = 'default';
    else if (ui.tool === 'text') overlayCanvas.style.cursor = 'text';
    else overlayCanvas.style.cursor = 'crosshair';
}

function updateUI() {
    document.querySelectorAll('.tool-btn').forEach(b => {
        b.classList.remove('active', 'bg-blue-600', 'text-white', 'shadow-md');
        b.classList.add('text-gray-600', 'hover:bg-gray-100');
    });
    const ab = document.getElementById(`btn-${ui.tool}`);
    if (ab) { ab.classList.remove('text-gray-600', 'hover:bg-gray-100'); ab.classList.add('active', 'bg-blue-600', 'text-white', 'shadow-md'); }

    const gridBtn = document.getElementById('btn-grid');
    if (ui.showGrid) { gridBtn.classList.add('text-blue-600', 'bg-blue-50'); gridBtn.classList.remove('text-gray-600', 'hover:bg-gray-100'); }
    else { gridBtn.classList.remove('text-blue-600', 'bg-blue-50'); gridBtn.classList.add('text-gray-600', 'hover:bg-gray-100'); }

    const eraserOpts = document.getElementById('eraser-options');
    if (ui.tool === 'eraser') {
        eraserOpts.classList.remove('hidden');
        const cls = (active) => active ? 'px-4 py-1.5 text-sm rounded-lg bg-blue-100 text-blue-700 font-bold transition' : 'px-4 py-1.5 text-sm rounded-lg hover:bg-gray-100 text-gray-600 font-medium transition';
        document.getElementById('btn-erase-stroke').className = cls(ui.eraseMode === 'stroke');
        document.getElementById('btn-erase-partial').className = cls(ui.eraseMode === 'partial');
    } else {
        eraserOpts.classList.add('hidden');
    }

    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    const ac = document.querySelector(`.color-btn[data-color="${ui.color}"]`);
    if (ac) ac.classList.add('active');
    updateCursor();
}

function switchTool(t) {
    abortCurrentStroke();
    if (editing && t !== 'text') commitTextEdit();
    if (ui.tool === 'select' && t !== 'select') { selectedObjectId = null; objectDrag = null; }
    ui.tool = t; updateUI();
}

document.getElementById('btn-pen').onclick = () => switchTool('pen');
document.getElementById('btn-eraser').onclick = () => switchTool('eraser');
document.getElementById('btn-arrow').onclick = () => switchTool('arrow');
document.getElementById('btn-rect').onclick = () => switchTool('rect');
document.getElementById('btn-circle').onclick = () => switchTool('circle');
document.getElementById('btn-text').onclick = () => switchTool('text');
document.getElementById('btn-select').onclick = () => switchTool('select');
// Select tool: double-click a text object to edit it in place
overlayCanvas.addEventListener('dblclick', e => {
    if (ui.tool !== 'select') return;
    const wp = getCanvasPoint(e.clientX, e.clientY);
    const hit = getObjectAt(wp.x, wp.y);
    if (hit && hit.type === 'text') { e.preventDefault(); openTextEditor(hit); }
});
document.getElementById('btn-pan').onclick = () => switchTool('pan');
document.getElementById('btn-grid').onclick = () => { ui.showGrid = !ui.showGrid; isDirty = true; updateUI(); };
// Touch mode toggle (only visible on touch devices): finger draws vs finger pans.
function updateTouchBtn() {
    const b = document.getElementById('btn-touch');
    const pan = ui.touchMode === 'pan';
    b.innerHTML = `<i data-lucide="${pan ? 'hand' : 'pointer'}" class="w-5 h-5"></i>`;
    b.title = pan ? 'Finger pans, stylus draws (tap to switch)' : 'Finger draws (tap to switch)';
    b.classList.toggle('text-blue-600', pan); b.classList.toggle('bg-blue-50', pan);
    lucide.createIcons({ nodes: b.querySelectorAll('[data-lucide]') });
}
document.getElementById('btn-touch').onclick = () => {
    ui.touchMode = ui.touchMode === 'pan' ? 'draw' : 'pan';
    localStorage.setItem('whiteboard.touchMode', ui.touchMode); updateTouchBtn();
};
updateTouchBtn();
// E-ink mode: adds body.eink (see CSS) and re-runs resize() for the pixel-ratio change.
function applyEink() {
    document.body.classList.toggle('eink', ui.eink);
    const b = document.getElementById('btn-eink');
    b.classList.toggle('text-blue-600', ui.eink); b.classList.toggle('bg-blue-50', ui.eink);
    resize(); // re-evaluates pixel ratio
}
document.getElementById('btn-eink').onclick = () => {
    ui.eink = !ui.eink; localStorage.setItem('whiteboard.eink', ui.eink ? '1' : '0'); applyEink();
};
applyEink();
// Hide the touch toggle on devices with no touch input at all
if (!('ontouchstart' in window) && !navigator.maxTouchPoints) document.getElementById('btn-touch').style.display = 'none';
document.getElementById('btn-erase-stroke').onclick = () => { ui.eraseMode = 'stroke'; updateUI(); };
document.getElementById('btn-erase-partial').onclick = () => { ui.eraseMode = 'partial'; updateUI(); };

document.querySelectorAll('.color-btn').forEach(btn => {
    btn.onclick = e => {
        ui.color = e.target.dataset.color;
        if (editing) { editing.color = ui.color; textEditor.style.color = ui.color; if (!editing.isNew) { const s = strokes.find(x => x.id === editing.id); if (s) { s.color = ui.color; writeObjectDoc(s); } } }
        else if (ui.tool === 'select' && selectedObjectId) {
            const s = strokes.find(x => x.id === selectedObjectId);
            if (s && s.type === 'text') { s.color = ui.color; writeObjectDoc(s); offscreenDirty = true; isDirty = true; }
        }
        if (!['pen', 'arrow', 'rect', 'circle', 'text', 'select'].includes(ui.tool)) switchTool('pen');
        updateUI();
    };
});
document.getElementById('thickness-slider').oninput = e => { ui.thickness = parseInt(e.target.value); };
document.getElementById('btn-undo').onclick = undo;
document.getElementById('btn-clear').onclick = async () => {
    abortCurrentStroke();
    const all = [...strokes];
    undoStack.push({ type: 'delete', strokes: all });
    if (user) all.forEach(s => deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'strokes', s.id)).catch(() => { }));
    strokes = []; offscreenDirty = true; isDirty = true;
};

// Keyboard: Ctrl/Cmd+Z undo; hold Space to pan temporarily (ignored while typing in a widget).
let spacePressed = false, previousTool = ui.tool;
window.addEventListener('keydown', e => {
    if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && ui.tool === 'select' && selectedObjectId
        && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        const s = strokes.find(x => x.id === selectedObjectId);
        if (s) {
            strokes = strokes.filter(x => x.id !== s.id);
            undoStack.push({ type: 'delete', strokes: [s] });
            if (user) deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'strokes', s.id)).catch(() => { });
            offscreenDirty = true; isDirty = true;
        }
        selectedObjectId = null; drawSelectionBox();
        return;
    }
    if (e.code === 'Space' && !spacePressed && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
        spacePressed = true; previousTool = ui.tool; switchTool('pan');
    }
});
window.addEventListener('keyup', e => {
    if (e.code === 'Space') { spacePressed = false; switchTool(previousTool); }
});

// Mobile Safari/Chrome: stop the *page* from zooming so pinch/double-tap only affect the board.
// iOS Safari: block pinch-zoom of the page itself and double-tap zoom on toolbars
['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => document.addEventListener(ev, e => e.preventDefault(), { passive: false }));
let lastTouchEnd = 0;
document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTouchEnd < 300 && !e.target.closest('textarea, input, select')) e.preventDefault();
    lastTouchEnd = now;
}, { passive: false });

updateUI(); updateZoomUI();
