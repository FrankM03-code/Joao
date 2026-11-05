// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// "Modo activo": while it is on, the session asks GNOME not to suspend the computer
// nor treat it as idle (which also keeps the screen on), like the Caffeine extension.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {notify} from './notice.js';

const BUS_NAME = 'org.gnome.SessionManager';
const OBJECT_PATH = '/org/gnome/SessionManager';
const INTERFACE = 'org.gnome.SessionManager';
const INHIBIT_SUSPEND = 4;
const INHIBIT_IDLE = 8;

export class KeepAwake {
    constructor(settings) {
        this._settings = settings;
        this._cookie = 0;
        this._busy = false;
        this._cancellable = new Gio.Cancellable();
        this._changedId = settings.connect('changed::keep-awake', () => this._sync());
        this._sync();
    }

    destroy() {
        this._settings.disconnect(this._changedId);
        this._settings = null;
        this._cancellable.cancel();
        this._release();
    }

    _call(method, params, done) {
        Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, INTERFACE, method, params, null,
            Gio.DBusCallFlags.NONE, -1, method === 'Inhibit' ? this._cancellable : null, done);
    }

    // One request at a time; whatever the switch says by the time it ends comes next.
    _sync() {
        if (this._busy)
            return;
        const wanted = this._settings.get_boolean('keep-awake');
        if (wanted && !this._cookie)
            this._hold();
        else if (!wanted && this._cookie)
            this._release();
    }

    _hold() {
        this._busy = true;
        const params = new GLib.Variant('(susu)', ['joao@frankm', 0, 'Modo activo de João', INHIBIT_SUSPEND | INHIBIT_IDLE]);
        this._call('Inhibit', params, (bus, result) => {
            let cookie = 0;
            let failure = null;
            try {
                [cookie] = bus.call_finish(result).deepUnpack();
            } catch (e) {
                failure = e;
            }
            if (!this._settings) {
                // João was switched off while asking: give back what the answer brought.
                this._cookie = cookie;
                this._release();
                return;
            }
            this._busy = false;
            this._cookie = cookie;
            if (failure) {
                logError(failure, 'João: modo activo');
                notify('No se pudo activar el modo activo', 'El equipo se puede suspender como siempre.');
                this._settings.set_boolean('keep-awake', false);
                return;
            }
            this._sync();
        });
    }

    _release() {
        const cookie = this._cookie;
        this._cookie = 0;
        if (!cookie)
            return;
        this._call('Uninhibit', new GLib.Variant('(u)', [cookie]), (bus, result) => {
            try {
                bus.call_finish(result);
            } catch (e) {
                logError(e, 'João: modo activo');
            }
        });
    }
}
