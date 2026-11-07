// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// With another monitor beside the primary one, the strip's screen edge stops nothing: the pointer
// goes on to the other monitor without ever resting on it. A barrier there holds the pointer and
// brings the strip back; pushing on lets the pointer through. It exists only while a window covers
// the strip, so a visible strip adds no friction on the way to the other monitor.
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const PASS_PRESSURE = 200;      // px pushed against the barrier to go through it
const FORGET_AFTER = 500;       // ms without pushing: the pressure starts again

const BUTTONS = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK |
    Clutter.ModifierType.BUTTON3_MASK;

export class EdgeBarrier {
    constructor(onTouch) {
        this._onTouch = onTouch;
        this._barrier = null;
        this._ids = [];
        this._place = '';
    }

    update(wanted, left) {
        const monitor = Main.layoutManager.primaryMonitor;
        const direction = left ? Meta.DisplayDirection.LEFT : Meta.DisplayDirection.RIGHT;
        const needed = wanted && monitor &&
            global.display.get_monitor_neighbor_index(Main.layoutManager.primaryIndex, direction) >= 0;
        // On the right, one pixel inside: Wayland stops the pointer ON the barrier's x, and X11 just
        // before it. Either way it stays on this monitor, where the strip counts it as near.
        const x = needed ? monitor.x + (left ? 0 : monitor.width - 1) : 0;
        const place = needed ? `${x},${monitor.y},${monitor.height},${left}` : '';
        if (place === this._place)
            return;
        this._remove();
        this._place = place;
        if (!needed)
            return;
        try {
            this._barrier = new Meta.Barrier({
                backend: global.backend,
                x1: x,
                x2: x,
                y1: monitor.y,
                y2: monitor.y + monitor.height,
                directions: left ? Meta.BarrierDirection.POSITIVE_X : Meta.BarrierDirection.NEGATIVE_X,
            });
        } catch (e) {
            logError(e, 'João: barrera del borde');
            return;
        }
        this._pressure = 0;
        this._lastHit = 0;
        this._ids = [
            this._barrier.connect('hit', (barrier, event) => this._onHit(barrier, event)),
            this._barrier.connect('left', () => {
                this._pressure = 0;
            }),
        ];
    }

    // Dragging a window, in a fullscreen game or on any other screen of the shell: the pointer goes by.
    get _mayHold() {
        const [, , mods] = global.get_pointer();
        return !(mods & BUTTONS) && Main.actionMode === Shell.ActionMode.NORMAL &&
            !Main.layoutManager.primaryMonitor?.inFullscreen;
    }

    _onHit(barrier, event) {
        if (event.released)
            return;
        if (!this._mayHold) {
            barrier.release(event);
            return;
        }
        this._onTouch();
        if (event.time - this._lastHit > FORGET_AFTER)
            this._pressure = 0;
        this._lastHit = event.time;
        this._pressure += Math.abs(event.dx);
        if (this._pressure >= PASS_PRESSURE)
            barrier.release(event);
    }

    _remove() {
        this._ids.forEach(id => this._barrier.disconnect(id));
        this._ids = [];
        this._barrier?.destroy();
        this._barrier = null;
    }

    destroy() {
        this._remove();
        this._place = '';
    }
}
