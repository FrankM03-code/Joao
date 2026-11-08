// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What saved scenes need from the desktop: the scenes mode when it is on (its SceneManager
// knows the scene on stage) and the windows to save. With the mode off, the "current scene"
// is whatever is visible on the workspace.
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isMaximized} from '../sistema/compat.js';
import {escenasManager, escenasStrip} from '../franja/escenasMode.js';
import {STRIP_MARGIN, STRIP_WIDTH} from '../franja/layout.js';

export {escenasManager, escenasStrip};

const STRIP_RESERVED = STRIP_MARGIN + STRIP_WIDTH;

// The bubble on the strip, when it is showing.
export function appsBubble() {
    const bubble = escenasStrip()?.appsBubble;
    return bubble?.enabled ? bubble : null;
}

export const appOf = win => Shell.WindowTracker.get_default().get_window_app(win);

export const isPlainWindow = win => win.get_window_type() === Meta.WindowType.NORMAL &&
    !win.get_transient_for() && !win.skip_taskbar;

export function pointerMonitor() {
    const [x, y] = global.get_pointer();
    const rect = new Mtk.Rectangle({x, y, width: 1, height: 1});
    const index = global.display.get_monitor_index_for_rect(rect);
    return Main.layoutManager.monitors[index] ? index : Main.layoutManager.primaryIndex;
}

// The work area of a monitor, minus the strip when it lives there.
export function usableArea(monitorIndex) {
    const work = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
    const area = {x: work.x, y: work.y, width: work.width, height: work.height};
    const manager = escenasManager();
    if (manager && monitorIndex === Main.layoutManager.primaryIndex) {
        if (manager.settings.get_string('lado') !== 'derecha')
            area.x += STRIP_RESERVED;
        area.width -= STRIP_RESERVED;
    }
    return area;
}

function currentWindows() {
    const manager = escenasManager();
    const windows = manager
        ? manager.activeScene?.windows ?? []
        : global.workspace_manager.get_active_workspace().list_windows();
    return windows.filter(w => isPlainWindow(w) && !w.minimized && appOf(w) && !appOf(w).is_window_backed());
}

// The current scene as saved data: stacking order, fractions of the same area a restoration uses.
export function captureWindows() {
    const windows = global.display.sort_windows_by_stacking(currentWindows());
    return windows.map((win, order) => {
        const app = appOf(win);
        const area = usableArea(win.get_monitor());
        const f = win.get_frame_rect();
        return {
            appId: app.get_id(),
            appName: app.get_name(),
            titleHint: win.get_title() ?? '',
            rect: {
                x: (f.x - area.x) / area.width,
                y: (f.y - area.y) / area.height,
                w: f.width / area.width,
                h: f.height / area.height,
            },
            maximized: isMaximized(win),
            order,
        };
    });
}

// ---------- taking a new window before the scene manager acts on it ----------
// Left alone, the scene manager gives a new window a scene of its own and sends the one on stage to the
// strip. For a window that belongs on stage that means everything flying away and coming back,
// so a restoration takes such windows first.

// Call it when the window is created. True: the scene manager will not act on it until it is told to.
export function takeNewWindow(win) {
    const release = escenasManager()?._pending.get(win);
    release?.();
    return !!release;
}

// A taken window that has not drawn yet goes back to the normal path.
export const returnNewWindow = win => escenasManager()?._onWindowCreated(win);

// A taken window that has drawn, and is not for the stage: what the scene manager would have done.
export const passDrawnWindow = win => escenasManager()?._addWindow(win, {activate: true});

// A taken window whose scene the user has left meanwhile waits in the strip.
export function sendDrawnToStrip(win) {
    const manager = escenasManager();
    manager?._addWindow(win, {activate: false});
    manager?.sendToStrip(win);
}

// A taken window joins the scene on stage; nothing else moves, nothing goes to the strip.
export function addToStage(win, stage) {
    const manager = escenasManager();
    if (!manager || manager._windowIds.has(win) || !manager._eligible(win))
        return;
    manager._watch(win);
    manager._markUsed(win);
    stage.windows.push(win);
    manager.emit('changed');
}

// A taken window starts a scene and takes the stage; what was there shrinks into the strip.
export function startStageWith(win) {
    const manager = escenasManager();
    if (!manager || manager._windowIds.has(win))
        return;
    manager._addWindow(win, {activate: false});
    const scene = manager.sceneOf(win);
    if (scene)
        manager.activate(scene, {focus: false, animate: true});
}
