// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The power view of the settings strip: back to the settings, who is signed in and for how long
// the machine has been on, Bloquear, Cerrar sesión, Suspender, Reiniciar, Apagar, and the check box
// "Volver a abrir las ventanas al encender".
// The check box is João's one key (reopen-after-poweroff, sistema/reopenAfterPowerOff.js), the
// same that the power bar and GNOME's power off dialog show: ticking it here ticks it there. As
// there, it shows only when logind can hibernate without asking.
// The actions behave as in João's power bar: Reiniciar, Cerrar sesión and Apagar act at once, with
// GNOME's dialog only when an app has unsaved work.
import AccountsService from 'gi://AccountsService';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {Avatar} from 'resource:///org/gnome/shell/ui/userWidget.js';

import {notify} from '../sistema/notice.js';
import {callSession, skipNextDialog} from '../sistema/powerBar.js';
import {REOPEN_KEY, canHibernate, hibernate} from '../sistema/reopenAfterPowerOff.js';
import {animations, run} from './iconosAnimados.js';

const warn = message => console.warn(`João: ${message}`);
const LOGOUT_NO_DIALOG = 1;
const CHECK_LABEL = 'Volver a abrir las ventanas al encender';
const NOTE_ON = 'Al apagar, el equipo hiberna y tus apps vuelven a abrirse donde estaban.';
const NOTE_OFF = 'Al apagar, todo se cierra por completo.';
const TICK_TIME = 300;
const center = () => new Graphene.Point({x: 0.5, y: 0.5});

// "3 h 12 min", from /proc/uptime.
function uptimeText() {
    try {
        const [, bytes] = GLib.file_get_contents('/proc/uptime');
        const seconds = Number.parseFloat(new TextDecoder().decode(bytes));
        const minutes = Math.floor(seconds / 60);
        const h = Math.floor(minutes / 60), m = minutes % 60;
        return h > 0 ? `${h} h ${m} min` : `${m} min`;
    } catch (e) {
        return null;
    }
}

// A check box whose tick draws itself.
const Casilla = GObject.registerClass({
    Properties: {ticked: GObject.ParamSpec.boolean('ticked', null, null, GObject.ParamFlags.READWRITE, false)},
}, class JoaoAjustesCasilla extends St.Button {
    _init() {
        super._init({style_class: 'joao-ajustes-casilla', can_focus: true, x_expand: true, accessible_name: CHECK_LABEL});
        const box = new St.BoxLayout({x_expand: true});
        // Square: the size comes from the stylesheet; the tick is drawn to fit it.
        this._box = new St.Bin({style_class: 'joao-ajustes-casilla-caja', x_expand: false, y_expand: false,
            x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER});
        this._tick = 0;
        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', () => this._paint());
        this._box.set_child(this._area);
        const label = new St.Label({style_class: 'joao-ajustes-casilla-texto', text: CHECK_LABEL, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.line_wrap = true;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(this._box);
        box.add_child(label);
        this.set_child(box);
        this._ticked = false;
        this.connect('clicked', () => {
            this.ticked = !this.ticked;
        });
    }

    get ticked() {
        return this._ticked;
    }

    set ticked(value) {
        if (value === this._ticked)
            return;
        this._ticked = value;
        if (value)
            this._box.add_style_pseudo_class('checked');
        else
            this._box.remove_style_pseudo_class('checked');
        this._stop?.();
        if (value && animations() && this.mapped) {
            this._stop = run(this, TICK_TIME, ms => {
                this._tick = Math.max(0.001, 1 - (1 - ms / TICK_TIME) ** 3);
                this._area.queue_repaint();
            });
        } else {
            this._tick = value ? 1 : 0;
            this._area.queue_repaint();
        }
        this.notify('ticked');
    }

    _paint() {
        const cr = this._area.get_context();
        if (this._tick > 0) {
            const pts = [[4.5, 9.5], [7.8, 12.8], [13.8, 5.6]];
            const l1 = Math.hypot(3.3, 3.3), l2 = Math.hypot(6, 7.2);
            let left = (l1 + l2) * this._tick;
            const [w, h] = this._area.get_surface_size();
            cr.scale(w / 18, h / 18);
            const c = this._area.get_theme_node().get_foreground_color();
            cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, 1);
            cr.setLineWidth(2.2);
            cr.setLineCap(1);
            cr.setLineJoin(1);
            cr.moveTo(...pts[0]);
            for (let i = 1; i < 3 && left > 0; i++) {
                const len = i === 1 ? l1 : l2;
                const f = Math.min(1, left / len);
                cr.lineTo(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f);
                left -= len;
            }
            cr.stroke();
        }
        cr.$dispose();
    }
});

export const VistaEnergia = GObject.registerClass({
    Signals: {'back': {}, 'acted': {}},
}, class JoaoAjustesVistaEnergia extends St.BoxLayout {
    _init(settings) {
        super._init({style_class: 'joao-ajustes-vista joao-ajustes-energia', orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, y_expand: true});
        this._settings = settings;
        this._actions = SystemActions.getDefault();
        this._restoreSkip = null;
        this.rows = [];

        this.backButton = new St.Button({style_class: 'joao-ajustes-volver', can_focus: true, x_align: Clutter.ActorAlign.START,
            label: '‹ Ajustes', accessible_name: 'Volver a los ajustes'});
        this.backButton.connect('clicked', () => this.emit('back'));
        this.add_child(this.backButton);

        // Who: avatar, name and time on.
        const who = new St.BoxLayout({style_class: 'joao-ajustes-usuario', x_expand: true});
        const manager = AccountsService.UserManager.get_default();
        this._user = manager.get_user(GLib.get_user_name());
        this._avatar = new Avatar(this._user, {iconSize: 40, styleClass: 'joao-ajustes-avatar'});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._name = new St.Label({style_class: 'joao-ajustes-usuario-nombre'});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._uptime = new St.Label({style_class: 'joao-ajustes-usuario-encendido'});
        text.add_child(this._name);
        text.add_child(this._uptime);
        who.add_child(this._avatar);
        who.add_child(text);
        this.add_child(who);
        this._userIds = [
            this._user.connect('notify::is-loaded', () => this._syncUser()),
            this._user.connect('changed', () => this._syncUser()),
        ];
        this._syncUser();
        this.rows.push(who);

        const list = new St.BoxLayout({style_class: 'joao-ajustes-energia-lista', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.add_child(list);
        this.buttons = {};
        for (const [id, icon, label, extra] of [
            ['lock', 'system-lock-screen-symbolic', 'Bloquear', ''],
            ['logout', 'system-log-out-symbolic', 'Cerrar sesión', ''],
            ['suspend', 'weather-clear-night-symbolic', 'Suspender', ''],
            ['restart', 'system-reboot-symbolic', 'Reiniciar', ''],
            ['poweroff', 'system-shutdown-symbolic', 'Apagar', 'peligro'],
        ]) {
            const button = this._row(id, icon, label, extra);
            list.add_child(button);
            this.rows.push(button);
        }
        this._bindAvailability();

        this._reopen = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, visible: false});
        this._check = new Casilla();
        this._note = new St.Label({style_class: 'joao-ajustes-nota'});
        this._note.clutter_text.line_wrap = true;
        this._note.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._reopen.add_child(this._check);
        this.add_child(this._reopen);
        this.add_child(this._note);
        this.rows.push(this._reopen, this._note);

        // The key both ways.
        this._check.ticked = settings.get_boolean(REOPEN_KEY);
        this._keyId = settings.connect(`changed::${REOPEN_KEY}`, () => {
            this._check.ticked = settings.get_boolean(REOPEN_KEY);
        });
        this._check.connect('notify::ticked', () => {
            if (settings.get_boolean(REOPEN_KEY) !== this._check.ticked)
                settings.set_boolean(REOPEN_KEY, this._check.ticked);
            this._syncNote();
        });
        this._canHibernate = false;
        this._syncNote();
        this._hibernateCheck = new Gio.Cancellable();
        canHibernate(this._hibernateCheck).then(yes => {
            if (this._hibernateCheck.is_cancelled())
                return;
            this._canHibernate = yes;
            this._reopen.visible = yes;
            this._syncNote();
        });
        this.connect('destroy', () => this._onDestroy());
    }

    _row(id, icon, label, extra) {
        const button = new St.Button({style_class: `joao-ajustes-energia-fila ${extra}`.trim(), can_focus: true,
            x_expand: true, accessible_name: label, pivot_point: center()});
        const box = new St.BoxLayout({x_expand: true});
        box.add_child(new St.Icon({icon_name: icon, icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
        button.set_child(box);
        button.connect('clicked', () => {
            button.remove_all_transitions();
            button.ease({scale_x: 0.95, scale_y: 0.95, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => button.ease({scale_x: 1, scale_y: 1, duration: 160,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD})});
            this.run(id);
        });
        this.buttons[id] = button;
        return button;
    }

    // Only what this machine and its administrator allow.
    _bindAvailability() {
        const flags = GObject.BindingFlags.SYNC_CREATE;
        this._bindings = [
            ['can-lock-screen', 'lock'],
            ['can-suspend', 'suspend'],
            ['can-restart', 'restart'],
            ['can-power-off', 'poweroff'],
        ].map(([prop, id]) => this._actions.bind_property(prop, this.buttons[id], 'visible', flags));
        this._lockdown = new Gio.Settings({schema_id: 'org.gnome.desktop.lockdown'});
        this._lockdown.bind('disable-log-out', this.buttons.logout, 'visible',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.INVERT_BOOLEAN);
    }

    _syncUser() {
        if (!this._user.is_loaded)
            return;
        this._name.text = this._user.get_real_name() || this._user.get_user_name();
        this._avatar.update();
    }

    _syncNote() {
        const reopen = this._canHibernate && this._check.ticked;
        this._note.text = reopen ? NOTE_ON : NOTE_OFF;
    }

    // Each time the view comes in.
    refresh() {
        const up = uptimeText();
        this._uptime.text = up ? `Encendido hace ${up}` : '';
    }

    // ---------- actions ----------

    run(id) {
        this.emit('acted');
        switch (id) {
        case 'lock':
            this._actions.activateLockScreen();
            break;
        case 'suspend':
            this._actions.activateSuspend();
            break;
        case 'logout':
            this._logout();
            break;
        case 'restart':
            this._endSession('restart');
            break;
        case 'poweroff':
            this._powerOff();
            break;
        }
    }

    _logout() {
        callSession('Logout', new GLib.Variant('(u)', [LOGOUT_NO_DIALOG]), (bus, res) => {
            try {
                bus.call_finish(res);
            } catch (e) {
                warn(`Logout: ${e.message}`);
                notify('No se pudo cerrar la sesión', 'Tus ventanas siguen abiertas.');
            }
        });
    }

    _endSession(action) {
        this._restoreSkip?.();
        const restore = this._restoreSkip = skipNextDialog(action === 'poweroff' ? 'ConfirmedShutdown' : 'ConfirmedReboot');
        callSession(action === 'poweroff' ? 'Shutdown' : 'Reboot', null, (bus, res) => {
            try {
                bus.call_finish(res);
            } catch (e) {
                restore();
                warn(`${action}: ${e.message}`);
                notify(action === 'poweroff' ? 'No se pudo apagar' : 'No se pudo reiniciar', 'Tus ventanas siguen abiertas.');
            }
        });
    }

    // Ticked (and possible): hibernate; if logind refuses, the usual power off.
    _powerOff() {
        if (!this._canHibernate || !this._settings.get_boolean(REOPEN_KEY)) {
            this._endSession('poweroff');
            return;
        }
        hibernate().catch(e => {
            warn(`Hibernate: ${e.message}`);
            this._endSession('poweroff');
        });
    }

    _onDestroy() {
        this._hibernateCheck.cancel();
        this._restoreSkip?.();
        this._restoreSkip = null;
        this._settings.disconnect(this._keyId);
        this._userIds.forEach(id => this._user.disconnect(id));
        this._bindings.forEach(b => b.unbind());
        Gio.Settings.unbind(this.buttons.logout, 'visible');
    }
});
