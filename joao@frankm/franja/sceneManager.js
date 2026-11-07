// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The model: which windows form each scene, and which scene is on stage.
//
// A scene is {id, windows: Meta.Window[], lastFocused, workspace, stamp, color}.
// Every normal window of the primary monitor belongs to exactly one scene.
// Each workspace has at most one scene on stage; the others are minimized and
// shown in the strip (in creation order). Signals: 'changed' (scenes or the one on stage
// changed) and 'layout-changed' (a window of the stage moved, resized…).
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {arrange, restorePlace} from './layout.js';

const CLOSE_WATCH = 15000;       // ms: how long a window being closed may still ask something
const BACK_GUARD = 1000;        // ms: a window minimized this soon after being brought back was not the user
const ATTENTION_SIGNALS = ['notify::demands-attention', 'notify::urgent'];
const WINDOW_SIGNALS = ['position-changed', 'size-changed', 'notify::fullscreen',
    'notify::maximized-horizontally', 'notify::maximized-vertically'];

export class SceneManager extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._scenes = [];
        this._active = new Map();          // Meta.Workspace -> scene
        this._minimizedByUs = new Set();   // given back when Escenas is switched off
        this._snapshots = new Map();       // Meta.Window -> {content, frame, buffer}
        this._places = new Map();          // Meta.Window -> its place before being arranged side by side
        this._windowIds = new Map();       // Meta.Window -> [signal ids]
        this._used = new Map();            // Meta.Window -> when it last had the focus (counter)
        this._useCount = 0;
        this._elsewhere = new WeakSet();   // windows left out because they are on another monitor
        this._broughtBack = new WeakMap(); // Meta.Window -> when someone else brought it back (ms)
        this._pending = new Map();         // Meta.Window -> stop() while waiting for its first frame
        this._closing = new Map();         // Meta.Window -> stop() while waiting for it to close
        this._sources = new Set();
        this._busy = 0;
        this._nextId = 1;
        this._stamp = 0;
        // Set by the strip: (scene, {leaving}) -> {x, y, width, height} | null,
        // where the scene's thumbnail is (or will be) for the (un)minimize animation.
        this.thumbnailRect = null;
    }

    start() {
        const display = global.display;
        this._displayIds = [
            display.connect('window-created', (d, win) => this._onWindowCreated(win)),
            display.connect('notify::focus-window', () => this._onFocus()),
            display.connect('window-entered-monitor', (d, i, win) => this._rehome(win)),
        ];
        this._wsIds = [
            global.workspace_manager.connect('active-workspace-changed', () => this.emit('changed')),
        ];
        // The primary monitor can change under the windows: they did not move, but they count now.
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () =>
            display.list_all_windows().forEach(win => this._rehome(win)));
        // Notifications mark the scenes of their app (and their text shows on hover).
        this._sourceIds = new Map();
        this._trayId = Main.messageTray.connect('source-added', (t, source) => this._watchSource(source));
        Main.messageTray.getSources().forEach(source => this._watchSource(source));

        // The windows already open: one scene each, oldest first. On every
        // workspace the most recently used *visible* window stays on stage; if
        // everything is minimized, nothing is on stage and all go to the strip.
        const windows = display.list_all_windows()
            .sort((a, b) => a.get_user_time() - b.get_user_time());
        for (const win of windows)
            this._addWindow(win, {activate: false});
        const focus = display.focus_window;
        for (const ws of new Set(this._scenes.map(s => s.workspace))) {
            const own = this._scenes.filter(s => s.workspace === ws);
            const visible = own.filter(s => s.windows.some(w => !w.minimized));
            const pick = visible.find(s => s.windows.includes(focus)) ?? visible.at(-1);
            if (pick)
                this.activate(pick, {focus: false, animate: false});
            this._busy++;
            try {
                own.filter(s => s !== pick).forEach(s => this._hide(s, false));
                own.filter(s => s !== pick).forEach(s => this._groupInStrip(s));
            } finally {
                this._busy--;
            }
        }
        this.emit('changed');
    }

    destroy() {
        if (this._monitorsId)
            Main.layoutManager.disconnect(this._monitorsId);
        this._monitorsId = 0;
        for (const id of this._displayIds ?? [])
            global.display.disconnect(id);
        for (const id of this._wsIds ?? [])
            global.workspace_manager.disconnect(id);
        if (this._trayId)
            Main.messageTray.disconnect(this._trayId);
        for (const [source, ids] of this._sourceIds ?? [])
            ids.forEach(id => source.disconnect(id));
        this._sourceIds?.clear();
        for (const stop of [...this._pending.values(), ...this._closing.values()])
            stop();
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        for (const [win, ids] of this._windowIds) {
            ids.forEach(id => win.disconnect(id));
            win.set_icon_geometry(null);
        }
        this._windowIds.clear();
        // Give the user back the windows we hid.
        for (const win of this._minimizedByUs) {
            if (win.minimized)
                win.unminimize();
        }
        this._minimizedByUs.clear();
        this._snapshots.clear();
        this._places.clear();
        this._used.clear();
        this._appColors?.clear();
        this._scenes = [];
        this._active.clear();
        this.thumbnailRect = null;
        this.disconnectAll();
    }

    // ---------- queries ----------

    get settings() {
        return this._settings;
    }

    get activeScene() {
        return this._activeOf(global.workspace_manager.get_active_workspace());
    }

    // Scenes of the current workspace in creation order.
    getScenes() {
        const ws = global.workspace_manager.get_active_workspace();
        return this._scenes.filter(s => s.workspace === ws);
    }

    getInactiveScenes() {
        const active = this.activeScene;
        return this.getScenes().filter(s => s !== active && s.windows.length);
    }

    sceneOf(win) {
        while (win) {
            const scene = this._scenes.find(s => s.windows.includes(win));
            if (scene)
                return scene;
            win = win.get_transient_for();
        }
        return null;
    }

    // The window that names a scene and leads its thumbnail.
    mainWindow(scene) {
        return scene.lastFocused ?? scene.windows.at(-1) ?? null;
    }

    // The scene's windows, most recently used first (the thumbnail's pile).
    // Dialogs are left out (they go with their parent).
    recentWindows(scene) {
        const own = scene.windows.filter(w => !w.get_transient_for());
        const list = own.length ? own : scene.windows.slice();
        const order = new Map(list.map((w, i) => [w, i]));
        const main = this.mainWindow(scene);
        return list.sort((a, b) => (b === main) - (a === main) ||
            (this._used.get(b) ?? 0) - (this._used.get(a) ?? 0) || order.get(b) - order.get(a));
    }

    _markUsed(win) {
        if (win && this._windowIds.has(win))
            this._used.set(win, ++this._useCount);
    }

    getSnapshot(win) {
        return this._snapshots.get(win) ?? null;
    }

    // ---------- actions ----------

    // @window: the window of the scene to focus (the one chosen in its
    // thumbnail's pile); by default the one that last had the focus.
    activate(scene, {focus = true, time = global.get_current_time(), animate = true, window = null, from = undefined} = {}) {
        if (!this._scenes.includes(scene))
            return;
        if (window && scene.windows.includes(window)) {
            scene.lastFocused = window;
            this._markUsed(window);
        }
        const ws = scene.workspace;
        const previous = this._activeOf(ws);
        scene.stamp = ++this._stamp;
        scene.activity = null;
        this._busy++;
        try {
            this._active.set(ws, scene);
            // Bring the incoming windows back first, so focus has somewhere to go
            // when the outgoing ones are minimized. They grow from their thumbnail.
            from = !animate ? null : from !== undefined ? from : this.thumbnailRect?.(scene, {leaving: false});
            for (const win of scene.windows) {
                this._minimizedByUs.delete(win);
                if (win.minimized) {
                    this._setIconGeometry(win, from);
                    win.unminimize();
                }
                this._snapshots.delete(win);
            }
            if (focus) {
                const target = [this.mainWindow(scene), ...scene.windows.slice().reverse()]
                    .find(w => w && !w.minimized);
                if (target) {
                    if (ws === global.workspace_manager.get_active_workspace())
                        target.activate(time);
                    else
                        Main.activateWindow(target, time);
                }
            }
            if (previous && previous !== scene) {
                this._hide(previous, animate);
                this._groupInStrip(previous);
            }
            if (scene.arrangeNext) {
                scene.arrangeNext = false;
                arrange(scene, this.mainWindow(scene), this._settings, this._places);
            }
        } finally {
            this._busy--;
        }
        this.emit('changed');
    }

    // A click on a thumbnail. A pile of one app's windows in the strip (several
    // Files windows grouped together) opens only @win, the one chosen in the
    // pile; it leaves the pile with its dialogs and the rest stay in the strip. Any other scene
    // opens whole.
    // @external: the window was already raised by someone else (a dock,
    // Alt+Tab): no focus change and no animation from the thumbnail.
    open(scene, win, {external = false} = {}) {
        if (!this._scenes.includes(scene))
            return;
        const own = scene.windows.filter(w => !w.get_transient_for());
        const app = this._appOf(own[0]);
        if (!win || !own.includes(win) || own.length < 2 || this._activeOf(scene.workspace) === scene ||
            !app || !own.every(w => this._appOf(w) === app)) {
            this.activate(scene, external ? {window: win, focus: false, animate: false} : {window: win});
            return;
        }
        const from = external ? null : this.thumbnailRect?.(scene, {leaving: false}) ?? null;
        this._busy++;
        try {
            const dialogs = scene.windows.filter(w => w !== win && this._belongsTo(w, win));
            this._detach(win, scene);
            const single = this._newScene(win);
            for (const d of dialogs) {
                scene.windows.splice(scene.windows.indexOf(d), 1);
                single.windows.push(d);
            }
            restorePlace(win, this._places);
            this.activate(single, external
                ? {window: win, focus: false, animate: false}
                : {window: win, from});
        } finally {
            this._busy--;
        }
    }

    // @win is a dialog (at any depth) of @parent.
    _belongsTo(win, parent) {
        for (let w = win.get_transient_for(); w; w = w.get_transient_for()) {
            if (w === parent)
                return true;
        }
        return false;
    }

    // Joins every window of @scene to the scene on stage.
    merge(scene) {
        const target = this._activeOf(scene.workspace);
        if (!target || target === scene || !this._scenes.includes(scene))
            return;
        this._busy++;
        try {
            this._scenes.splice(this._scenes.indexOf(scene), 1);
            for (const win of scene.windows) {
                target.windows.push(win);
                this._minimizedByUs.delete(win);
                this._snapshots.delete(win);
                if (win.minimized)
                    win.unminimize();
            }
            const main = this.mainWindow(target) ?? this.mainWindow(scene);
            target.lastFocused ??= main;
            arrange(target, main, this._settings, this._places);
            this.mainWindow(scene)?.activate(global.get_current_time());
        } finally {
            this._busy--;
        }
        this.emit('changed');
    }

    // Takes @win (the focused window by default) out of its scene into a new
    // scene of its own, which goes on stage; the rest of its old scene leaves.
    separate(win = global.display.focus_window) {
        const scene = this.sceneOf(win);
        if (!scene || !scene.windows.includes(win) || scene.windows.length < 2)
            return false;
        this._detach(win, scene);
        restorePlace(win, this._places);
        const own = this._newScene(win);
        this.activate(own);
        this._settle(scene);
        return true;
    }

    // The strip's "+" (click or a window dropped on it): the window becomes a
    // scene of its own in the strip; the rest of the stage stays.
    sendToStrip(win) {
        const scene = this.sceneOf(win);
        if (!scene || !scene.windows.includes(win))
            return false;
        const ws = scene.workspace;
        this._busy++;
        try {
            if (scene.windows.length === 1) {
                if (this._activeOf(ws) === scene)
                    this._active.delete(ws);
                this._hide(scene, true);
                this._groupInStrip(scene);
            } else {
                this._detach(win, scene);
                const own = this._newScene(win);
                this._hide(own, true);
                this._groupInStrip(own);
                restorePlace(win, this._places);
                if (this._activeOf(ws) === scene) {
                    this._settle(scene);
                    this.mainWindow(scene)?.activate(global.get_current_time());
                }
            }
        } finally {
            this._busy--;
        }
        this.emit('changed');
        return true;
    }

    // A scene on stage lost a window: the rest share the room again, or the
    // one left alone goes back to its own place.
    _settle(scene) {
        if (!this._scenes.includes(scene))
            return;
        const visible = scene.windows.filter(w => !w.minimized && !w.get_transient_for());
        if (visible.length >= 2)
            arrange(scene, this.mainWindow(scene) ?? visible[0], this._settings, this._places);
        else
            visible.forEach(w => restorePlace(w, this._places));
    }

    // ---------- closing a window from the strip ----------

    // Asks a window of the strip to close, without bringing it on stage. If it
    // has something to ask (unsaved changes), its dialog could not be seen
    // while the window is minimized, so the scene comes on stage to show it.
    closeWindow(win) {
        const scene = this.sceneOf(win);
        if (!scene || this._closing.has(win))
            return;
        let dialog = false;
        win.foreach_transient(() => {
            dialog = true;
            return false;
        });
        if (dialog) {
            this.open(scene, win);
            return;
        }
        const display = global.display;
        let timeoutId = 0;
        const stop = () => {
            display.disconnect(createdId);
            win.disconnect(goneId);
            if (timeoutId)
                GLib.source_remove(timeoutId);
            timeoutId = 0;
            this._closing.delete(win);
        };
        const createdId = display.connect('window-created', (d, created) => this._later(() => {
            if (this._closing.get(win) !== stop || created.get_transient_for() !== win)
                return;
            stop();
            const current = this.sceneOf(win);
            if (current)
                this.open(current, win);
        }));
        const goneId = win.connect('unmanaged', stop);
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLOSE_WATCH, () => {
            timeoutId = 0;
            stop();
            return GLib.SOURCE_REMOVE;
        });
        this._closing.set(win, stop);
        win.delete(global.get_current_time());
    }

    // ---------- windows coming and going ----------

    _eligible(win) {
        return win.get_window_type() === Meta.WindowType.NORMAL &&
            !win.skip_taskbar &&
            !win.is_on_all_workspaces() &&
            win.get_workspace() !== null &&
            win.get_monitor() === Main.layoutManager.primaryIndex;
    }

    // New windows are placed (monitor, workspace) by the time their first frame
    // is drawn: wait for it before giving them a scene.
    _onWindowCreated(win) {
        const actor = win.get_compositor_private();
        if (!actor) {
            this._later(() => this._addWindow(win, {activate: true}));
            return;
        }
        // Once the window is unmanaged its actor may be gone, and its signals with it.
        const stop = ({actorAlive = true} = {}) => {
            if (actorAlive)
                actor.disconnect(frameId);
            win.disconnect(goneId);
            this._pending.delete(win);
        };
        const frameId = actor.connect('first-frame', () => {
            stop();
            this._addWindow(win, {activate: true});
        });
        // A window can be unmanaged before drawing anything.
        const goneId = win.connect('unmanaged', () => stop({actorAlive: false}));
        this._pending.set(win, stop);
    }

    _addWindow(win, {activate}) {
        if (this._windowIds.has(win) || win.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        // Dialog-like normal windows go with their parent.
        const parentScene = win.get_transient_for() ? this.sceneOf(win.get_transient_for()) : null;
        if (!parentScene && !this._eligible(win)) {
            this._elsewhere.add(win);
            return;
        }
        this._elsewhere.delete(win);
        this._watch(win);
        this._markUsed(win);
        if (parentScene) {
            parentScene.windows.push(win);
            this.emit('changed');
            return;
        }
        const scene = this._newScene(win);
        if (activate)
            this.activate(scene, {focus: false, animate: false});
        else
            this.emit('changed');
    }

    _watch(win) {
        const ids = [
            win.connect('unmanaged', () => this._removeWindow(win)),
            win.connect('workspace-changed', () => this._rehome(win)),
            win.connect('notify::minimized', () => this._onMinimized(win)),
            ...ATTENTION_SIGNALS.map(s => win.connect(s, () => this._onAttention(win))),
            ...WINDOW_SIGNALS.map(s => win.connect(s, () => {
                if (this.sceneOf(win) === this.activeScene)
                    this.emit('layout-changed');
            })),
        ];
        this._windowIds.set(win, ids);
    }

    _nextColor() {
        // The least used color of the palette, so neighbors differ.
        const used = this._scenes.map(s => s.color);
        let best = 0;
        for (let c = 1; c < 8; c++) {
            if (used.filter(u => u === c).length < used.filter(u => u === best).length)
                best = c;
        }
        return best;
    }

    // One app keeps one color: the windows of a pile leave it and come back
    // (each one its own scene for a while), and the number on the card must
    // not change color every time.
    _colorFor(win) {
        const app = this._appOf(win);
        if (!app)
            return this._nextColor();
        this._appColors ??= new Map();
        if (!this._appColors.has(app))
            this._appColors.set(app, this._nextColor());
        return this._appColors.get(app);
    }

    _newScene(win) {
        const scene = {id: this._nextId++, windows: [win], lastFocused: win,
            workspace: win.get_workspace(), stamp: ++this._stamp, color: this._colorFor(win)};
        this._scenes.push(scene);
        return scene;
    }

    _drop(scene) {
        const i = this._scenes.indexOf(scene);
        if (i >= 0)
            this._scenes.splice(i, 1);
    }

    // Takes @win out of @scene; an emptied scene disappears and, if it was on
    // stage, the most recently used one takes its place.
    _detach(win, scene) {
        scene.windows.splice(scene.windows.indexOf(win), 1);
        if (scene.lastFocused === win)
            scene.lastFocused = scene.windows.at(-1) ?? null;
        if (scene.windows.length)
            return;
        this._drop(scene);
        if (this._active.get(scene.workspace) === scene) {
            this._active.delete(scene.workspace);
            const ws = scene.workspace;
            // Let Mutter settle focus first: if it focuses a window, that scene wins.
            this._later(() => {
                if (this._activeOf(ws))
                    return;
                const next = this._scenes.filter(s => s.workspace === ws && s.windows.length)
                    .sort((a, b) => b.stamp - a.stamp)[0];
                if (next)
                    this.activate(next, {focus: ws === global.workspace_manager.get_active_workspace()});
            });
        }
    }

    _removeWindow(win) {
        this._windowIds.get(win)?.forEach(id => win.disconnect(id));
        this._windowIds.delete(win);
        this._minimizedByUs.delete(win);
        this._snapshots.delete(win);
        this._places.delete(win);
        this._used.delete(win);
        const scene = this._scenes.find(s => s.windows.includes(win));
        if (scene) {
            this._detach(win, scene);
            if (this._activeOf(scene.workspace) === scene)
                this._settle(scene);
        }
        this.emit('changed');
    }

    // The window changed workspace or monitor: it starts a scene of its own there
    // (or stops being ours if it left the primary monitor).
    _rehome(win) {
        if (this._busy)
            return;
        // Not ours: only one known to be on another monitor comes in here. A window being created
        // also enters a monitor, before it is placed: that one waits for its first frame.
        if (!this._windowIds.has(win)) {
            if (this._elsewhere.has(win) && this._eligible(win))
                this._addWindow(win, {activate: win.has_focus() || !this._activeOf(win.get_workspace())});
            return;
        }
        // A window being closed loses its workspace (and emits
        // workspace-changed) before 'unmanaged': moving it then aborts mutter.
        if (!win.get_workspace() && !win.is_on_all_workspaces())
            return;
        const scene = this._scenes.find(s => s.windows.includes(win));
        const eligible = this._eligible(win);
        if (scene && eligible && scene.workspace === win.get_workspace())
            return;
        if (scene) {
            // It leaves a shared scene: the others share the room again and
            // it gets its own size back.
            this._detach(win, scene);
            restorePlace(win, this._places);
            if (this._activeOf(scene.workspace) === scene)
                this._settle(scene);
        }
        if (eligible && !win.get_transient_for()) {
            const own = this._newScene(win);
            if (win.has_focus() || !this._activeOf(own.workspace))
                this.activate(own, {focus: false, animate: false});
        } else {
            this._windowIds.get(win).forEach(id => win.disconnect(id));
            this._windowIds.delete(win);
            this._elsewhere.add(win);
            this._snapshots.delete(win);
            this._used.delete(win);
            win.set_icon_geometry(null);
            if (this._minimizedByUs.delete(win) && win.minimized)
                win.unminimize();
        }
        this.emit('changed');
    }

    // ---------- activity: attention requests and notifications ----------

    _onAttention(win) {
        if (win.demands_attention || win.urgent)
            this._markActivity(this.sceneOf(win), null);
    }

    _watchSource(source) {
        if (this._sourceIds.has(source))
            return;
        this._sourceIds.set(source, [
            source.connect('notification-added', (src, notification) => this._onNotification(src, notification)),
            source.connect('destroy', () => this._sourceIds.delete(source)),
        ]);
    }

    _onNotification(source, notification) {
        const app = source.app ?? source._app ?? null;
        if (!app)
            return;
        const tracker = Shell.WindowTracker.get_default();
        const text = [notification.title, notification.body].filter(Boolean).join(': ');
        for (const scene of this._scenes) {
            if (scene.windows.some(w => tracker.get_window_app(w) === app))
                this._markActivity(scene, text);
        }
    }

    // Only scenes waiting in the strip get the mark; going on stage clears it.
    _markActivity(scene, text) {
        if (!scene || this._activeOf(scene.workspace) === scene)
            return;
        scene.activity = {text: text ?? scene.activity?.text ?? null};
        this.emit('changed');
    }

    // ---------- grouping by app in the strip ----------

    _appOf(win) {
        return Shell.WindowTracker.get_default().get_window_app(win);
    }

    // A scene in the strip made only of windows of @app (and not @except).
    _appSceneInStrip(app, workspace, except = null) {
        if (!app)
            return null;
        return this._scenes.find(s => s !== except && s.workspace === workspace && s.windows.length &&
            this._activeOf(workspace) !== s && s.windows.every(w => this._appOf(w) === app)) ?? null;
    }

    // @scene just went to the strip: if it is made of one app's windows and the
    // strip already has a scene of that app, they become one card that counts
    // them. Its windows are put side by
    // side the next time it goes on stage.
    _groupInStrip(scene) {
        if (!this._scenes.includes(scene) || this._activeOf(scene.workspace) === scene || !scene.windows.length)
            return;
        const app = this._appOf(scene.windows[0]);
        if (!app || !scene.windows.every(w => this._appOf(w) === app))
            return;
        const same = this._appSceneInStrip(app, scene.workspace, scene);
        if (!same)
            return;
        same.windows.push(...scene.windows);
        same.arrangeNext = true;
        // The window that just left the stage is the most recently used one:
        // it leads the pile.
        if (scene.lastFocused)
            same.lastFocused = scene.lastFocused;
        if (scene.activity && !same.activity)
            same.activity = scene.activity;
        this._drop(scene);
    }

    // ---------- following the user ----------

    // Alt+Tab, the overview, a dock…: focusing a window of a scene in the strip
    // puts that scene on stage.
    _onFocus() {
        const win = global.display.focus_window;
        this._markUsed(win);
        if (this._busy || !win)
            return;
        const scene = this.sceneOf(win);
        if (!scene)
            return;
        if (scene.windows.includes(win))
            scene.lastFocused = win;
        // A dock opening one window of a pile in the strip brings only that
        // one, like choosing it in the pile (not all the Files windows).
        if (this._activeOf(scene.workspace) !== scene)
            this.open(scene, win, {external: true});
    }

    _onMinimized(win) {
        if (this._busy)
            return;
        const scene = this.sceneOf(win);
        if (!scene)
            return;
        const back = this._broughtBack.get(win);
        this._broughtBack.delete(win);
        if (win.minimized && back !== undefined && Date.now() - back < BACK_GUARD) {
            // Hidden again right after being asked for, and not by us: nobody minimizes a window
            // that fast on purpose. Seen on X11 (Firefox, 2026-11-07): the screen was left empty.
            // It is brought back once more; the log says what happened.
            console.warn(`João: "${win.title}" se minimizó ${Date.now() - back} ms después de volver; se muestra otra vez`);
            this._later(() => {
                if (win.minimized && this.sceneOf(win))
                    this.activate(this.sceneOf(win), {window: win, animate: false});
            });
            return;
        }
        if (win.minimized) {
            // Its last frame, while the minimize animation still shows it.
            this._takeSnapshot(win);
            // The user minimized one window of a shared scene on stage: it leaves
            // the scene and goes to the strip as a scene of its own.
            if (this._activeOf(scene.workspace) === scene && scene.windows.includes(win) &&
                !win.get_transient_for() && scene.windows.some(w => w !== win && !w.minimized)) {
                this._busy++;
                try {
                    this._detach(win, scene);
                    this._groupInStrip(this._newScene(win));
                    restorePlace(win, this._places);
                    this._settle(scene);
                } finally {
                    this._busy--;
                }
                this.emit('changed');
                return;
            }
            // The user minimized the last visible window of the stage: the whole
            // scene goes to the strip.
            if (this._activeOf(scene.workspace) === scene && scene.windows.every(w => w.minimized)) {
                this._active.delete(scene.workspace);
                this._groupInStrip(scene);
                this.emit('changed');
            }
            return;
        }
        // Someone else brought back a window we had hidden.
        this._minimizedByUs.delete(win);
        this._broughtBack.set(win, Date.now());
        if (this._activeOf(scene.workspace) !== scene)
            this.open(scene, win, {external: true});
    }

    // Minimize the scene's windows (shrinking into its thumbnail).
    _hide(scene, animate) {
        const to = animate ? this.thumbnailRect?.(scene, {leaving: true}) : null;
        for (const win of scene.windows) {
            if (win.minimized)
                continue;
            const back = this._broughtBack.get(win);
            if (back !== undefined && Date.now() - back < BACK_GUARD)
                console.warn(`João: se esconde "${win.title}" ${Date.now() - back} ms después de volver\n${new Error().stack}`);
            this._takeSnapshot(win);
            this._minimizedByUs.add(win);
            this._setIconGeometry(win, to);
            win.minimize();
        }
    }

    // GNOME's (un)minimize animation goes to the window's icon geometry.
    _setIconGeometry(win, rect) {
        if (rect) {
            win.set_icon_geometry(new Mtk.Rectangle({x: Math.round(rect.x), y: Math.round(rect.y),
                width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height))}));
        } else {
            win.set_icon_geometry(null);
        }
    }

    // The window's last frame, kept for the thumbnail (a clone of a minimized
    // window can paint nothing, mostly on X11).
    _takeSnapshot(win) {
        const actor = win.get_compositor_private();
        if (!actor)
            return;
        try {
            const content = actor.paint_to_content(null);
            if (content)
                this._snapshots.set(win, {content, frame: win.get_frame_rect(), buffer: win.get_buffer_rect()});
        } catch (e) {
            this._snapshots.delete(win);
        }
    }

    _activeOf(ws) {
        const scene = this._active.get(ws);
        return scene && this._scenes.includes(scene) ? scene : null;
    }

    _later(fn) {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._sources.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
    }
}
