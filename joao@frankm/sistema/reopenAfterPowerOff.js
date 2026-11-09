// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// "Volver a abrir los programas al encender": Apagar hibernates instead of powering off, so the
// whole session comes back as it was. One key holds the choice; it shows in João's power bar and in
// GNOME's power off dialog, and only when logind says this machine can hibernate ("yes").
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {CheckBox} from 'resource:///org/gnome/shell/ui/checkBox.js';
import {EndSessionDialog} from 'resource:///org/gnome/shell/ui/endSessionDialog.js';

export const REOPEN_KEY = 'reopen-after-poweroff';
const LABEL = 'Volver a abrir los programas al encender';
const NOTE_ON = 'Se verá como un apagado normal, pero al encender todo estará como lo dejaste.';
const NOTE_OFF = 'Se cerrarán todos los programas. Guarda tu trabajo antes de apagar.';
const SHUTDOWN_DIALOG = 1;

const warn = message => console.warn(`João: ${message}`);

function callLogind(method, params, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call('org.freedesktop.login1', '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager', method, params, null,
            Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION, -1, cancellable, (bus, res) => {
                try {
                    resolve(bus.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// "challenge" (a password first) does not count: Apagar must never wait on a prompt.
export async function canHibernate(cancellable = null) {
    try {
        const [answer] = (await callLogind('CanHibernate', null, cancellable)).deepUnpack();
        return answer === 'yes';
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            warn(`CanHibernate: ${e.message}`);
        return false;
    }
}

export function hibernate() {
    return callLogind('Hibernate', new GLib.Variant('(b)', [true]), null);
}

// The check box with its note below, bound to the key both ways.
export function reopenRow(settings, styleClass) {
    const row = new St.BoxLayout({style_class: styleClass, orientation: Clutter.Orientation.VERTICAL, x_expand: true});
    const checkBox = new CheckBox(LABEL);
    const note = new St.Label({style_class: 'joao-reopen-note'});
    note.clutter_text.line_wrap = true;
    note.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    row.add_child(checkBox);
    row.add_child(note);
    settings.bind(REOPEN_KEY, checkBox, 'checked', Gio.SettingsBindFlags.DEFAULT);
    const sync = () => {
        note.text = checkBox.checked ? NOTE_ON : NOTE_OFF;
    };
    checkBox.connect('notify::checked', sync);
    sync();
    row.connect('destroy', () => Gio.Settings.unbind(checkBox, 'checked'));
    row.checkBox = checkBox;
    return row;
}

// GNOME's power off dialog shows when João's Apagar finds unsaved work, and also for the power key
// and Ctrl+Alt+Del. Its countdown confirms through _confirm too, so the check box counts there.
export class ReopenInDialog {
    constructor(settings) {
        this._settings = settings;
        this._rows = new Map();
        this._injections = new InjectionManager();
        const proto = EndSessionDialog.prototype;
        if (!proto.OpenAsync || !proto._confirm)
            return;
        const self = this;
        this._injections.overrideMethod(proto, 'OpenAsync', original => async function (parameters, invocation) {
            const show = parameters[0] === SHUTDOWN_DIALOG && await self.canHibernate();
            self._rowFor(this).visible = show;
            return original.call(this, parameters, invocation);
        });
        this._injections.overrideMethod(proto, '_confirm', original => async function (signal) {
            const row = self._rows.get(this);
            // Installing updates needs the real power off.
            const updates = this._checkBox.visible && this._checkBox.checked;
            if (signal !== 'ConfirmedShutdown' || !row?.visible || !row.checkBox.checked || updates)
                return original.call(this, signal);
            this._stopTimer();
            try {
                await self.hibernate();
            } catch (e) {
                warn(`Hibernate: ${e.message}`);
                return original.call(this, signal);
            }
            // gnome-session drops its own power off; the machine is already going to sleep.
            this.cancel();
            return undefined;
        });
    }

    // Separate so the tests can replace them.
    canHibernate() {
        return canHibernate();
    }

    hibernate() {
        return hibernate();
    }

    _rowFor(dialog) {
        let row = this._rows.get(dialog);
        if (!row) {
            row = reopenRow(this._settings, 'joao-reopen joao-reopen-dialog');
            dialog._messageDialogContent.insert_child_above(row, dialog._checkBox);
            this._rows.set(dialog, row);
        }
        return row;
    }

    destroy() {
        this._injections.clear();
        for (const row of this._rows.values())
            row.destroy();
        this._rows.clear();
    }
}
