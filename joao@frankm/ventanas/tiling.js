// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Tiling by hand: drag a window to a screen edge or corner, or use the arrow shortcuts, and it
// takes half or a quarter of the room the strip leaves free. Replaces GNOME's edge tiling while
// on; what GNOME had is given back when it goes off. Key 'tiling-activo'.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {pointerMonitor, usableArea} from '../escenas/escenasLink.js';
import {glide} from '../escenas/glide.js';
import {GAP} from '../escenas/layouts.js';
import {forget, remember, tiledRecord} from './tiledWindows.js';
import {MAXIMIZE, nextZone, RESTORE, zoneAt, zoneRect} from './zones.js';

const POLL = 30;           // ms between looks at the pointer while dragging
const PREVIEW_TIME = 120;
const FIT_DELAY = 200;     // ms an app gets to answer before seeing whether it took the size
const MOVE_OPS = [Meta.GrabOp.MOVING, Meta.GrabOp.MOVING_UNCONSTRAINED];

const frameOf = win => {
    const f = win.get_frame_rect();
    return {x: f.x, y: f.y, width: f.width, height: f.height};
};

const canTile = win => !!win && win.get_window_type() === Meta.WindowType.NORMAL &&
    win.resizeable && !win.is_fullscreen();

const isMaximized = win => win.get_maximized() === Meta.MaximizeFlags.BOTH;

export class Tiling {
    constructor(settings) {
        this._settings = settings;
        this._sources = new Set();
        this._mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._syncId = settings.connect('changed::tiling-activo', () => this._sync());
        this._sync();
    }

    destroy() {
        this._settings.disconnect(this._syncId);
        this._stop();
        this._sources.forEach(id => GLib.source_remove(id));
        this._sources.clear();
        this._mutter = null;
        this._settings = null;
    }

    // An arrow shortcut on the focused window: 'left', 'right', 'up' or 'down'.
    key(direction) {
        const win = global.display.get_focus_window();
        if (!canTile(win))
            return;
        const zone = isMaximized(win) ? MAXIMIZE : tiledRecord(win)?.zone ?? null;
        const next = nextZone(zone, direction);
        if (next === RESTORE)
            this._restore(win);
        else if (next)
            this._place(win, next, win.get_monitor());
    }

    _sync() {
        if (this._settings.get_boolean('tiling-activo'))
            this._start();
        else
            this._stop();
    }

    _start() {
        if (this._grabIds)
            return;
        // Remembered in the settings: a shell that dies with this on must still give it back.
        if (this._mutter.get_boolean('edge-tiling')) {
            this._settings.set_boolean('tiling-edge-taken', true);
            this._mutter.set_boolean('edge-tiling', false);
        }
        this._grabIds = [
            global.display.connect('grab-op-begin', (d, win, op) => this._onGrabBegin(win, op)),
            global.display.connect('grab-op-end', (d, win) => this._onGrabEnd(win)),
        ];
    }

    _stop() {
        if (this._settings.get_boolean('tiling-edge-taken')) {
            this._mutter.set_boolean('edge-tiling', true);
            this._settings.set_boolean('tiling-edge-taken', false);
        }
        if (!this._grabIds)
            return;
        this._grabIds.forEach(id => global.display.disconnect(id));
        this._grabIds = null;
        this._stopPolling();
        this._moving = null;
        this._preview?.destroy();
        this._preview = null;
    }

    // ---------- dragging ----------

    _onGrabBegin(win, op) {
        if (!canTile(win) || !MOVE_OPS.includes(op))
            return;
        this._stopPolling();
        this._moving = win;
        this._zone = null;
        this._record = tiledRecord(win);   // once it moves the record no longer matches
        this._before = frameOf(win);
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL, () => {
            this._look();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onGrabEnd(win) {
        if (!this._moving || win !== this._moving)
            return;
        this._look();
        const {_zone: zone, _record: record, _before: before} = this;
        const monitor = pointerMonitor();
        this._stopPolling();
        this._moving = null;
        this._record = null;
        this._hidePreview();
        // Mutter is still finishing the drag: a move asked for now would be lost.
        this._later(0, () => {
            const frame = frameOf(win);
            if (zone)
                this._place(win, zone, monitor, record);
            else if (record && (frame.x !== before.x || frame.y !== before.y))
                this._untile(win, frame, record);
        });
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._sources.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
    }

    _stopPolling() {
        if (this._pollId)
            GLib.source_remove(this._pollId);
        this._pollId = 0;
    }

    _look() {
        const [x, y] = global.get_pointer();
        const index = pointerMonitor();
        const zone = zoneAt(x, y, Main.layoutManager.monitors[index], this._sharedEdges(index));
        if (zone === this._zone)
            return;
        this._zone = zone;
        if (zone)
            this._showPreview(this._rectOf(zone, index));
        else
            this._hidePreview();
    }

    _sharedEdges(index) {
        const shared = direction => global.display.get_monitor_neighbor_index(index, direction) >= 0;
        return {
            left: shared(Meta.DisplayDirection.LEFT),
            right: shared(Meta.DisplayDirection.RIGHT),
            top: shared(Meta.DisplayDirection.UP),
            bottom: shared(Meta.DisplayDirection.DOWN),
        };
    }

    // Maximizing covers the whole work area, strip's room too (the strip then gets out of the way).
    _rectOf(zone, monitor) {
        if (zone === MAXIMIZE) {
            const work = Main.layoutManager.getWorkAreaForMonitor(monitor);
            return {x: work.x, y: work.y, width: work.width, height: work.height};
        }
        return zoneRect(zone, usableArea(monitor), GAP);
    }

    // ---------- the preview ----------

    _showPreview(rect) {
        if (!this._preview) {
            this._preview = new St.Widget({style_class: 'joao-tile-preview', opacity: 0, visible: false});
            global.window_group.add_child(this._preview);
        }
        const preview = this._preview;
        const actor = this._moving?.get_compositor_private();
        if (actor)
            global.window_group.set_child_below_sibling(preview, actor);
        preview.remove_all_transitions();
        if (!preview.visible) {
            preview.set_position(rect.x, rect.y);
            preview.set_size(rect.width, rect.height);
            preview.show();
        }
        preview.ease({
            x: rect.x, y: rect.y, width: rect.width, height: rect.height, opacity: 255,
            duration: PREVIEW_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hidePreview() {
        const preview = this._preview;
        if (!preview?.visible)
            return;
        preview.remove_all_transitions();
        preview.ease({
            opacity: 0,
            duration: PREVIEW_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: finished => {
                if (finished)
                    preview.hide();
            },
        });
    }

    // ---------- placing ----------

    // @record: what the window held before a drag moved it away from its tiled place.
    _place(win, zone, monitor, record = tiledRecord(win)) {
        if (zone === MAXIMIZE) {
            win.maximize(Meta.MaximizeFlags.BOTH);
            return;
        }
        const from = frameOf(win);
        if (win.get_maximized())
            win.unmaximize(Meta.MaximizeFlags.BOTH);
        const rect = this._rectOf(zone, monitor);
        remember(win, zone, rect, record?.original ?? frameOf(win));
        win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        glide(win, from);
        this._later(FIT_DELAY, () => this._keepInside(win, rect));
    }

    // An app can refuse to get that small: it keeps its size, against the zone's outer edges,
    // and does not hang off the screen.
    _keepInside(win, rect) {
        const record = tiledRecord(win);
        if (!record || record.rect !== rect || isMaximized(win))
            return;
        const f = win.get_frame_rect();
        const bounds = Main.layoutManager.getWorkAreaForMonitor(win.get_monitor());
        const wantX = record.zone.endsWith('right') ? rect.x + rect.width - f.width : rect.x;
        const wantY = record.zone.startsWith('bottom') ? rect.y + rect.height - f.height : rect.y;
        const x = Math.max(bounds.x, Math.min(wantX, bounds.x + bounds.width - f.width));
        const y = Math.max(bounds.y, Math.min(wantY, bounds.y + bounds.height - f.height));
        rect.x = x;
        rect.y = y;
        if (x !== f.x || y !== f.y)
            win.move_frame(true, x, y);
    }

    _restore(win) {
        if (isMaximized(win)) {
            win.unmaximize(Meta.MaximizeFlags.BOTH);
            return;
        }
        const record = tiledRecord(win);
        forget(win);
        if (!record)
            return;
        const from = frameOf(win);
        const {x, y, width, height} = record.original;
        win.move_resize_frame(true, x, y, width, height);
        glide(win, from);
    }

    // Dragged out of its place to no zone: it gets its size back where it was dropped, with the
    // pointer over the same part of the window.
    _untile(win, frame, record) {
        forget(win);
        const [pointerX] = global.get_pointer();
        const {width, height} = record.original;
        const x = pointerX - Math.round(width * (pointerX - frame.x) / frame.width);
        win.move_resize_frame(true, x, frame.y, width, height);
        glide(win, frame);
    }
}
