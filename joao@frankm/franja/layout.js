// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Shared measures, the scene palette and the side-by-side arrangement of the
// windows of the scene on stage.
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isPartlyMaximized, maximize, unmaximize as leaveMaximized} from '../sistema/compat.js';
import {tiledRecord} from '../ventanas/tiledWindows.js';

export const THUMB_WIDTH = 154;      // the front card
export const THUMB_HEIGHT = 89;
export const FAN_X = 16;             // each layer behind: inwards…
export const FAN_Y = 8;              // …and up
export const FAN_LAYERS = 3;
export const STACK_WIDTH = THUMB_WIDTH + (FAN_LAYERS - 1) * FAN_X;
export const STACK_HEIGHT = THUMB_HEIGHT + (FAN_LAYERS - 1) * FAN_Y;
const STRIP_PADDING = 8;
export const STRIP_WIDTH = STACK_WIDTH + 2 * STRIP_PADDING;
export const STRIP_MARGIN = 16;      // from the screen edge and the top bar
const GAP = 16;                      // between windows of the stage

// One color per scene, rotating.
export const PALETTE = ['#3584e4', '#2ec27e', '#e5a50a', '#ff7800', '#e01b24', '#9141ac', '#1c9fb0', '#e66198'];

export function sceneColor(scene) {
    return PALETTE[(scene.color ?? 0) % PALETTE.length];
}

export function workArea() {
    const index = Main.layoutManager.primaryIndex;
    return index >= 0 ? Main.layoutManager.getWorkAreaForMonitor(index) : null;
}

// The part of the work area that the strip leaves free.
function freeArea(settings) {
    const area = workArea();
    if (!area)
        return null;
    const reserved = STRIP_MARGIN + STRIP_WIDTH;
    const left = settings.get_string('lado') !== 'derecha';
    return {
        x: left ? area.x + reserved : area.x,
        y: area.y,
        width: area.width - reserved,
        height: area.height,
    };
}

function unmaximize(win) {
    if (win.is_fullscreen())
        win.unmake_fullscreen();
    if (isPartlyMaximized(win))
        leaveMaximized(win);
}

// The windows of the scene on stage side by side, all the same width, with
// equal margins (main window first). Only with two or more visible windows, none tiled by hand.
// @saved keeps each window's place from before the first arrangement, so it
// can go back there when it is alone again (restorePlace).
export function arrange(scene, main, settings, saved) {
    if (!settings.get_boolean('ordenar-ventanas'))
        return;
    // (allows_resize() is false for a maximized window: not a filter here.)
    const windows = scene.windows.filter(w => !w.minimized && !w.get_transient_for() &&
        w.get_window_type() === Meta.WindowType.NORMAL);
    // What the user tiled by hand stays where they put it.
    if (windows.length < 2 || windows.some(tiledRecord))
        return;
    const area = freeArea(settings);
    if (!area)
        return;
    const ordered = [main, ...windows.filter(w => w !== main)].filter(w => windows.includes(w));
    const n = ordered.length;
    const width = Math.floor((area.width - GAP * (n + 1)) / n);
    const height = area.height - 2 * GAP;
    ordered.forEach((win, i) => {
        if (!saved.has(win)) {
            const f = win.get_frame_rect();
            saved.set(win, {x: f.x, y: f.y, width: f.width, height: f.height,
                maximized: isPartlyMaximized(win)});
        }
        unmaximize(win);
        win.move_resize_frame(true, area.x + GAP + i * (width + GAP), area.y + GAP, width, height);
    });
}

// Back to where (and how big) the window was before being arranged.
export function restorePlace(win, saved) {
    const place = saved.get(win);
    saved.delete(win);
    if (!place || (!win.get_workspace() && !win.is_on_all_workspaces()))
        return;
    win.move_resize_frame(true, place.x, place.y, place.width, place.height);
    if (place.maximized)
        maximize(win);
}
