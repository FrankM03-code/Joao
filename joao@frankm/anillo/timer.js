// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The ring's timer. What is left is always worked out from the time it ends, never counted down
// second by second. That end is kept as wall-clock time in ~/.local/share/joao/timer.json, so a
// timer goes on after the shell restarts, and a suspended computer still rings when it wakes up
// late (the monotonic clock stops while suspended).
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {JsonFile} from '../sistema/jsonFile.js';

const VERSION = 1;
const now = () => GLib.get_real_time() / 1e6;

// 754 → "12:34"; an hour or more → "1:02:34".
export function clock(seconds) {
    const total = Math.max(0, Math.ceil(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}

export function minutes(seconds) {
    const m = Math.round(seconds / 60);
    if (m < 1)
        return `${Math.round(seconds)} segundos`;
    return m === 1 ? '1 minuto' : `${m} minutos`;
}

export const Timer = GObject.registerClass({
    Signals: {
        'changed': {},      // started, paused, resumed, stopped
        'tick': {},         // once a second while it runs
        'finished': {},
    },
}, class JoaoTimer extends GObject.Object {
    _init() {
        super._init();
        this._duration = 0;
        this._label = '';
        this._endsAt = null;    // seconds, wall clock, while it runs
        this._left = null;      // seconds, while paused
        this._tickId = 0;
        this._endId = 0;
        this._file = new JsonFile('timer.json', data => (data?.version === VERSION ? data : null));
        this._file.load(data => this._restore(data));
    }

    get active() {
        return this._endsAt !== null || this._left !== null;
    }

    get running() {
        return this._endsAt !== null;
    }

    get paused() {
        return this._left !== null;
    }

    get label() {
        return this._label;
    }

    get duration() {
        return this._duration;
    }

    get remaining() {
        if (this._endsAt !== null)
            return Math.max(0, this._endsAt - now());
        return this._left ?? 0;
    }

    // What is left of the whole, 1 → 0.
    get fraction() {
        return this._duration ? Math.min(1, this.remaining / this._duration) : 0;
    }

    // "Horno · 12:40", or the time alone.
    get summary() {
        const left = clock(this.remaining);
        return this._label ? `${this._label} · ${left}` : `Quedan ${left}`;
    }

    start(duration, label = '') {
        this._duration = duration;
        this._label = label.trim();
        this._left = null;
        this._endsAt = now() + duration;
        this._run();
    }

    pause() {
        if (!this.running)
            return;
        this._left = this.remaining;
        this._endsAt = null;
        this._stopClocks();
        this._changed();
    }

    resume() {
        if (!this.paused)
            return;
        this._endsAt = now() + this._left;
        this._left = null;
        this._run();
    }

    stop() {
        this._endsAt = null;
        this._left = null;
        this._stopClocks();
        this._changed();
    }

    _run() {
        this._stopClocks();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this.emit('tick');
            return GLib.SOURCE_CONTINUE;
        });
        // The end itself on time, not at the next whole second.
        this._endId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.round(this.remaining * 1000)), () => {
            this._endId = 0;
            this._finish();
            return GLib.SOURCE_REMOVE;
        });
        this._changed();
    }

    _finish() {
        // A late wake-up from suspend: the timeout may come before the wall clock says so.
        if (this.remaining > 0.5) {
            this._run();
            return;
        }
        this._endsAt = null;
        this._left = null;
        this._stopClocks();
        this._changed();
        this.emit('finished');
    }

    _stopClocks() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        if (this._endId)
            GLib.source_remove(this._endId);
        this._endId = 0;
    }

    _changed() {
        this._file.save({version: VERSION, duration: this._duration, label: this._label, endsAt: this._endsAt, left: this._left});
        this.emit('changed');
    }

    // Back from a restart: it goes on, or rings at once if its time went by meanwhile.
    _restore(data) {
        if (!data || this.active || !(data.duration > 0))
            return;
        this._duration = data.duration;
        this._label = String(data.label ?? '');
        if (typeof data.left === 'number') {
            this._left = data.left;
            this.emit('changed');
        } else if (typeof data.endsAt === 'number') {
            this._endsAt = data.endsAt;
            this._run();
        }
    }

    destroy() {
        this._stopClocks();
        this._file.destroy();
    }
});
