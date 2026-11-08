// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Opens a saved scene: reuses windows already open, launches what is missing, puts every
// window in its place and, with the scene manager on, gathers them into one scene on stage.
//
// Every window goes straight to its own place the moment it is drawn and joins the scene on
// stage, so what is already placed never moves and nothing passes through the strip.
// The scene is ready, on top and focused as soon as the last window is there; a short watch
// follows for apps that open more windows or move themselves after showing up.
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {isMaximized, isPartlyMaximized, maximize, unmaximize} from '../sistema/compat.js';
import {notify} from '../sistema/notice.js';
import {addToStage, appOf, escenasManager, isPlainWindow, passDrawnWindow, pointerMonitor,
    returnNewWindow, sendDrawnToStrip, startStageWith, takeNewWindow, usableArea} from './escenasLink.js';
import {launch} from '../franja/appShortcuts.js';
import {fold} from '../pantalla/appSearch.js';
import {glide} from './glide.js';
import {layoutRects} from './layouts.js';

const PUMP = 50;             // how often it looks whether the next app can go
const NEXT_GAP = 350;        // one app shows up, a moment, and then the next: never all at once
const NEXT_WAIT = 5000;      // an app this slow does not hold up the others; it can still arrive
const SAME_APP_GAP = 800;    // a browser may reopen several windows by itself: give it time
const GRACE = 2000;          // once all are there, for windows the apps reopen on their own
const SETTLE = 300;          // for the apps to answer the last move before checking it
const LATE_LIMIT = 30;       // seconds a slow app can still arrive after the time limit
const MAX_CORRECTIONS = 3;   // an app that keeps refusing its place is left where it wants
const CORRECT_DELAY = 80;    // an app moving itself may do it in several steps

const matchesTitle = (win, hint) => !!hint && fold(win.get_title()) === fold(hint);
const rectOf = win => {
    const f = win.get_frame_rect();
    return {x: f.x, y: f.y, width: f.width, height: f.height};
};
const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

// Runs fn when the window is drawn and has real geometry: right after that paint with @now,
// otherwise after the scene manager has seen it.
// 'first-frame' is emitted while mutter is painting: raising, moving or activating a window
// there aborts gnome-shell on Wayland (frame_in_progress assertion). So even @now waits
// for the paint to end, with a high priority idle that still runs before the next frame.
function whenDrawn(win, sources, fn, {now = false, onGone = null} = {}) {
    const idle = () => {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            sources.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        sources.add(id);
    };
    const actor = win.get_compositor_private();
    if (!actor) {
        idle();
        return () => {};
    }
    // Once the window is unmanaged its actor may be gone, and its signals with it.
    let frameId = 0;
    let goneId = 0;
    const stop = ({actorAlive = true} = {}) => {
        if (actorAlive && frameId)
            actor.disconnect(frameId);
        if (goneId)
            win.disconnect(goneId);
        frameId = goneId = 0;
    };
    frameId = actor.connect('first-frame', () => {
        actor.disconnect(frameId);
        frameId = 0;
        // 'unmanaged' stays connected until fn runs: a window closed meanwhile is not touched.
        const id = GLib.idle_add(now ? GLib.PRIORITY_HIGH_IDLE : GLib.PRIORITY_DEFAULT_IDLE, () => {
            sources.delete(id);
            stop();
            fn();
            return GLib.SOURCE_REMOVE;
        });
        sources.add(id);
    });
    goneId = win.connect('unmanaged', () => {
        stop({actorAlive: false});
        onGone?.();
    });
    return stop;
}

function firstEmptyWorkspace() {
    const wm = global.workspace_manager;
    const last = wm.get_workspace_by_index(wm.n_workspaces - 1);
    if (!last.list_windows().some(w => isPlainWindow(w)))
        return last;
    return wm.append_new_workspace(false, global.get_current_time());
}

const EXTRA = Symbol('one more window of an app of the scene');

class Restoration {
    constructor(scene, {timeout, reuse, newWorkspace, onEnd}) {
        this._scene = scene;
        this._timeout = timeout;
        this._reuse = reuse;
        this._onEnd = onEnd;
        this._sources = new Set();
        this._stops = new Set();
        this._gone = new Map();      // Meta.Window -> 'unmanaged' handler id
        this._moved = new Map();     // Meta.Window -> geometry handler ids
        this._corrections = new Map();   // Meta.Window -> how many times it was put back
        this._held = new Set();      // the user took these with the mouse: theirs from now on
        this._taken = new Set();     // taken from the scene manager, not drawn yet
        this._extras = [];           // {win, rect}: windows the apps opened beyond the saved ones
        this._failed = new Set();
        this._apps = new Map();      // appId -> {waiting, nextAt}
        this._stage = null;          // the the scene manager scene this restoration is building
        this._presented = false;

        this._monitor = pointerMonitor();
        this._workspace = newWorkspace
            ? firstEmptyWorkspace() : global.workspace_manager.get_active_workspace();
        if (!this._workspace.active)
            this._workspace.activate(global.get_current_time());
        const windows = [...scene.windows].sort((a, b) => a.order - b.order);
        const rects = layoutRects(scene.layout, windows, usableArea(this._monitor));
        this._slots = windows.map((w, i) => ({...w, target: rects[i], win: null, launched: false}));
    }

    start() {
        if (this._reuse)
            this._reuseOpenWindows();
        for (const slot of this._slots) {
            if (!slot.win && !Shell.AppSystem.get_default().lookup_app(slot.appId)) {
                slot.launched = true;
                this._failed.add(slot.appName || slot.appId);
            }
        }
        // Windows already on screen travel to their place from where they are now.
        const before = this._slots.filter(s => s.win && !s.win.minimized).map(s => [s.win, rectOf(s.win)]);
        this._gather();
        this._placeAll();
        before.forEach(([win, from]) => glide(win, from));
        this._grabId = global.display.connect('grab-op-begin', (d, win) => {
            if (win)
                this._held.add(win);
        });
        if (this._pending().length === 0) {
            this._allThere(SETTLE);
            return;
        }
        this._createdId = global.display.connect('window-created', (d, win) => this._onCreated(win));
        // They open one after another: the limit grows with how many there are.
        this._limitId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._timeout * this._pending().length, () => this._onTimeLimit());
        this._pumpId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PUMP, () => this._pump());
        this._pump();
    }

    cancel() {
        this._stopWaiting();
        if (this._graceId)
            GLib.source_remove(this._graceId);
        this._graceId = 0;
        if (this._correctId)
            GLib.source_remove(this._correctId);
        this._correctId = 0;
        if (this._grabId)
            global.display.disconnect(this._grabId);
        this._grabId = 0;
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        for (const stop of this._stops)
            stop();
        this._stops.clear();
        for (const win of this._taken)
            returnNewWindow(win);
        this._taken.clear();
        for (const [win, ids] of this._moved)
            ids.forEach(id => win.disconnect(id));
        this._moved.clear();
        for (const [win, id] of this._gone)
            win.disconnect(id);
        this._gone.clear();
    }

    _stopWaiting() {
        if (this._createdId)
            global.display.disconnect(this._createdId);
        this._createdId = 0;
        for (const id of [this._limitId, this._pumpId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._limitId = this._pumpId = 0;
    }

    _pending() {
        return this._slots.filter(s => !s.win && !this._failedSlot(s));
    }

    _failedSlot(slot) {
        return this._failed.has(slot.appName || slot.appId);
    }

    _reuseOpenWindows() {
        const manager = escenasManager();
        const open = global.display.list_all_windows().filter(w => isPlainWindow(w) && w.get_workspace());
        // A window can come along when its scene holds only apps of this saved scene (alone,
        // in a pile of its app, or this very scene opened earlier). A scene with other
        // apps as well belongs to something else and is left alone.
        const wanted = new Set(this._slots.map(slot => slot.appId));
        const free = win => {
            const scene = manager?.sceneOf(win);
            return !scene || scene.windows.every(w => w.get_transient_for() || wanted.has(appOf(w)?.get_id()));
        };
        const used = new Set();
        for (const slot of this._slots) {
            const candidates = open.filter(w => !used.has(w) && appOf(w)?.get_id() === slot.appId && free(w));
            const win = candidates.find(w => matchesTitle(w, slot.titleHint)) ?? candidates[0];
            if (win) {
                used.add(win);
                this._assign(slot, win);
            }
        }
    }

    _assign(slot, win) {
        slot.win = win;
        this._watch(win);
        if (win.get_workspace() !== this._workspace)
            win.change_workspace(this._workspace);
    }

    _watch(win) {
        if (this._gone.has(win))
            return;
        this._gone.set(win, win.connect('unmanaged', () => {
            win.disconnect(this._gone.get(win));
            this._gone.delete(win);
            this._moved.get(win)?.forEach(id => win.disconnect(id));
            this._moved.delete(win);
            for (const slot of this._slots) {
                if (slot.win === win)
                    slot.win = null;
            }
            this._extras = this._extras.filter(e => e.win !== win);
        }));
        this._moved.set(win, ['size-changed', 'position-changed'].map(signal =>
            win.connect(signal, () => this._queueCorrection())));
    }

    // Launches one window per tick. A second window of one app waits for the first to
    // show up, so an app that reopens its own windows does not get extra ones.
    _pump() {
        const now = GLib.get_monotonic_time() / 1000;
        // Only one on its way at a time.
        const last = this._lastLaunch;
        if (last) {
            if (last.slot.win && !last.arrivedAt)
                last.arrivedAt = now;
            const ready = last.arrivedAt ? now >= last.arrivedAt + NEXT_GAP : now >= last.at + NEXT_WAIT;
            if (!ready)
                return GLib.SOURCE_CONTINUE;
        }
        for (const slot of this._slots) {
            if (slot.win || slot.launched)
                continue;
            const state = this._apps.get(slot.appId) ?? {waiting: false, nextAt: 0};
            this._apps.set(slot.appId, state);
            if (state.waiting || now < state.nextAt)
                continue;
            slot.launched = true;
            state.waiting = true;
            this._lastLaunch = {slot, at: now, arrivedAt: 0};
            if (!this._launch(slot)) {
                state.waiting = false;
                this._lastLaunch = null;
            }
            return GLib.SOURCE_CONTINUE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    _launch(slot) {
        try {
            const app = Shell.AppSystem.get_default().lookup_app(slot.appId);
            launch(app);
            return true;
        } catch (e) {
            logError(e, `João: abrir ${slot.appId}`);
            this._failed.add(slot.appName || slot.appId);
            return false;
        }
    }

    _onCreated(win) {
        if (win.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        const taken = takeNewWindow(win);
        if (taken)
            this._taken.add(win);
        const stop = whenDrawn(win, this._sources, () => {
            this._stops.delete(stop);
            this._taken.delete(win);
            this._onDrawn(win, taken);
        }, {
            now: taken,
            onGone: () => {
                this._stops.delete(stop);
                this._taken.delete(win);
            },
        });
        this._stops.add(stop);
    }

    _onDrawn(win, taken) {
        const slot = this._slotFor(win);
        // Not of this scene (another app, a dialog, a loading window): as if João were not here.
        if (!slot) {
            if (taken)
                passDrawnWindow(win);
            return;
        }
        if (slot === EXTRA) {
            this._watch(win);
            this._extras.push({win, rect: rectOf(win)});
        } else {
            this._assign(slot, win);
            this._place(win, slot.target, slot.maximized);
        }
        if (taken)
            this._join(win);
        else
            this._gather();
        this._onArrival();
    }

    // The saved window this new one fills, EXTRA for one more of its app, or null if not ours.
    _slotFor(win) {
        if ((!win.get_workspace() && !win.is_on_all_workspaces()) || !isPlainWindow(win))
            return null;
        const id = appOf(win)?.get_id();
        const own = this._slots.filter(s => s.appId === id);
        if (!own.length)
            return null;
        const state = this._apps.get(id);
        if (state) {
            state.waiting = false;
            state.nextAt = GLib.get_monotonic_time() / 1000 + SAME_APP_GAP;
        }
        const free = own.filter(s => !s.win);
        return free.find(s => matchesTitle(win, s.titleHint)) ?? free[0] ?? EXTRA;
    }

    _ownWindows() {
        return [...this._slots.map(s => s.win), ...this._extras.map(e => e.win)].filter(w => w);
    }

    // The user went elsewhere while this was opening: from then on it does not pull them back.
    get _userLeft() {
        if (!this._workspace.active)
            return true;
        const manager = escenasManager();
        return !!manager && !!this._stage && manager.activeScene !== this._stage;
    }

    // A window taken from the scene manager enters the scene on stage without disturbing it.
    _join(win) {
        const manager = escenasManager();
        if (this._userLeft) {
            sendDrawnToStrip(win);
            return;
        }
        const stage = manager?.activeScene;
        if (stage?.windows.some(w => w !== win && this._ownWindows().includes(w))) {
            addToStage(win, stage);
        } else {
            startStageWith(win);
        }
        this._stage = manager?.activeScene ?? null;
    }

    _onArrival() {
        if (this._pending().length === 0)
            this._allThere(GRACE);
    }

    // Everything is there: the scene is ready now. Only a short watch remains.
    _allThere(watch) {
        this._stopWaiting();
        this._gather();
        this._placeAll();
        this._present();
        if (this._graceId)
            GLib.source_remove(this._graceId);
        this._graceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, watch, () => {
            this._graceId = 0;
            this._conclude();
            return GLib.SOURCE_REMOVE;
        });
        // New windows of these apps can still come during the watch.
        if (watch > SETTLE)
            this._createdId = global.display.connect('window-created', (d, win) => this._onCreated(win));
    }

    // A slow app ran out the time limit. What is there is ready; it can still arrive.
    _onTimeLimit() {
        this._limitId = 0;
        this._present();
        // An app can start without showing its window: ask once more.
        const asked = new Set();
        for (const slot of this._pending()) {
            if (slot.launched && !asked.has(slot.appId)) {
                asked.add(slot.appId);
                this._launch(slot);
            }
        }
        this._limitId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LATE_LIMIT, () => {
            this._limitId = 0;
            this._allThere(SETTLE);
            return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
    }

    // The windows on top in their order, the right one with the keyboard. Once only: later
    // the user may already be doing something else.
    _present() {
        if (this._presented || this._userLeft)
            return;
        const placed = this._slots.filter(s => s.win);
        if (!placed.length)
            return;
        this._presented = true;
        placed.forEach(slot => slot.win.raise());
        // A computed layout has its main window first; 'free' keeps the stacking order.
        const top = this._scene.layout === 'free' ? placed.at(-1) : placed[0];
        top.win.activate(global.get_current_time());
    }

    // One scene on stage holding all of this restoration's windows: for windows that were
    // open already or that could not be taken from the scene manager when they appeared.
    _gather() {
        const manager = escenasManager();
        if (!manager || this._userLeft)
            return;
        const wins = this._ownWindows().filter(w => manager.sceneOf(w));
        if (!wins.length)
            return;
        const foreign = scene => scene.windows.some(w => !w.get_transient_for() && !wins.includes(w));

        const stage = manager.activeScene;
        if (!stage || !stage.windows.some(w => wins.includes(w))) {
            const scene = manager.sceneOf(wins[0]);
            if (foreign(scene))
                manager.open(scene, wins[0], {external: true});
            else
                manager.activate(scene, {focus: false, animate: true});
        }
        // A window in a pile comes out alone; the scene on stage then joins it.
        for (let round = 0; round <= wins.length; round++) {
            const win = wins.find(w => manager.sceneOf(w) !== manager.activeScene);
            if (!win)
                break;
            const scene = manager.sceneOf(win);
            if (foreign(scene)) {
                const previous = manager.activeScene;
                manager.open(scene, win, {external: true});
                if (previous !== manager.activeScene)
                    manager.merge(previous);
            } else {
                manager.merge(scene);
            }
        }
        this._stage = manager.activeScene;
    }

    _placeAll() {
        if (this._userLeft)
            return;
        for (const slot of this._slots) {
            if (slot.win)
                this._place(slot.win, slot.target, slot.maximized);
        }
        for (const extra of this._extras)
            this._place(extra.win, extra.rect, false);
    }

    // Asks for a move only if the window is not there yet: every request makes the app redraw.
    _place(win, rect, maximized) {
        if (!win.get_workspace() && !win.is_on_all_workspaces())
            return;
        if (win.minimized)
            win.unminimize();
        if (win.is_fullscreen())
            win.unmake_fullscreen();
        if (win.get_monitor() !== this._monitor)
            win.move_to_monitor(this._monitor);
        if (maximized && isMaximized(win))
            return;
        if (isPartlyMaximized(win))
            unmaximize(win);
        if (!sameRect(rectOf(win), rect))
            win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        if (maximized)
            maximize(win);
    }

    // Some apps set their own size or position after showing up. A few steps of it wait for
    // the app to stop; a window the user is holding is not touched.
    _queueCorrection() {
        if (this._correctId || this._correcting)
            return;
        this._correctId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CORRECT_DELAY, () => {
            this._correctId = 0;
            this._correct();
            return GLib.SOURCE_REMOVE;
        });
    }

    _correct() {
        if (this._userLeft)
            return;
        this._correcting = true;
        for (const slot of this._slots) {
            const win = slot.win;
            if (!win || this._held.has(win) || sameRect(rectOf(win), slot.target) ||
                (slot.maximized && isMaximized(win)))
                continue;
            const count = this._corrections.get(win) ?? 0;
            if (count >= MAX_CORRECTIONS)
                continue;
            this._corrections.set(win, count + 1);
            const from = rectOf(win);
            this._place(win, slot.target, slot.maximized);
            glide(win, from);
        }
        this._correcting = false;
    }

    _conclude() {
        this._stopWaiting();
        if (!this._userLeft) {
            for (const slot of this._slots) {
                if (!slot.win || this._held.has(slot.win))
                    continue;
                // An app with a size of its own (a calculator) refuses a move that comes with
                // a new size; asked for the move alone, it obeys.
                const f = slot.win.get_frame_rect();
                if (!slot.maximized && (f.x !== slot.target.x || f.y !== slot.target.y))
                    slot.win.move_frame(true, slot.target.x, slot.target.y);
            }
        }
        for (const slot of this._slots) {
            if (!slot.win)
                this._failed.add(slot.appName || slot.appId);
        }
        for (const name of this._failed)
            notify(`No se pudo abrir ${name}`, `Escena «${this._scene.name}»`);
        this.cancel();
        this._onEnd();
    }
}

export class SceneRestorer {
    constructor(settings, store) {
        this._settings = settings;
        this._store = store;
        this._run = null;
        this._openStop = null;
    }

    get busy() {
        return this._run !== null;
    }

    restore(scene, {newWorkspace = false} = {}) {
        this.cancel();
        const run = new Restoration(scene, {
            timeout: this._settings.get_int('restore-timeout'),
            reuse: this._settings.get_boolean('restore-reuse-windows'),
            newWorkspace,
            onEnd: () => {
                if (this._run === run)
                    this._run = null;
            },
        });
        this._run = run;
        this._store.recordUse(scene.id);
        run.start();
    }

    cancel() {
        this._run?.cancel();
        this._run = null;
        this._openStop?.();
        this._openStop = null;
    }

    // One app from the row of apps. A closed app opens inside the scene on stage;
    // one already running is simply brought up, wherever it is.
    openInActiveScene(app) {
        this._openStop?.();
        this._openStop = null;
        const manager = escenasManager();
        const previous = manager?.activeScene;
        const running = app.get_windows().length > 0;
        if (running)
            app.activate();
        else
            launch(app);
        if (running || !previous)
            return;

        const sources = new Set();
        let stopDrawn = null;
        const stop = () => {
            if (createdId)
                global.display.disconnect(createdId);
            createdId = 0;
            if (limitId)
                GLib.source_remove(limitId);
            limitId = 0;
            stopDrawn?.();
            sources.forEach(id => GLib.source_remove(id));
            sources.clear();
            this._openStop = null;
        };
        let createdId = global.display.connect('window-created', (d, win) => {
            if (win.get_window_type() !== Meta.WindowType.NORMAL || stopDrawn)
                return;
            stopDrawn = whenDrawn(win, sources, () => {
                stopDrawn = null;
                if (appOf(win) !== app)
                    return;
                const now = escenasManager();
                if (now?.getScenes().includes(previous) && now.sceneOf(win) === now.activeScene &&
                    now.activeScene !== previous)
                    now.merge(previous);
                stop();
            }, {
                onGone: () => {
                    stopDrawn = null;
                },
            });
        });
        let limitId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._settings.get_int('restore-timeout'), () => {
            limitId = 0;
            stop();
            return GLib.SOURCE_REMOVE;
        });
        this._openStop = stop;
    }

    destroy() {
        this.cancel();
    }
}
