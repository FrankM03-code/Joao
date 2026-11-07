// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Which windows were tiled by hand, and the size each one had before. On its own, with nothing
// else imported from João, because the strip's arrangement asks it too.
import GLib from 'gi://GLib';

import {isMaximized} from '../sistema/compat.js';

const SETTLE = 1000000;   // µs a window may take to reach its new place (a client can be slow)
const records = new WeakMap();   // Meta.Window -> {zone, rect, original, at}

export function remember(win, zone, rect, original) {
    records.set(win, {zone, rect, original, at: GLib.get_monotonic_time()});
}

export function forget(win) {
    records.delete(win);
}

// The window's record while it is still where it was tiled; maximizing it does not lose it,
// because unmaximizing brings it back to that place.
export function tiledRecord(win) {
    const record = records.get(win);
    if (!record)
        return null;
    if (isMaximized(win) || GLib.get_monotonic_time() - record.at < SETTLE)
        return record;
    const frame = win.get_frame_rect();
    return frame.x === record.rect.x && frame.y === record.rect.y ? record : null;
}
