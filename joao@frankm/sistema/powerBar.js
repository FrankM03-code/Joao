// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Foot of the panel: one bar with three states in the same space.
//   main:      Ajustes, Captura, Grabar, Bloquear, Energía
//   power:     back, Suspender, Hibernar, Reiniciar, Salir, Apagar
//   countdown: Reiniciar, Salir and Apagar wait 10 s with a Cancelar button
// It goes back to main when it stops being on screen, which also cancels a countdown.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {EndSessionDialog} from 'resource:///org/gnome/shell/ui/endSessionDialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {launchSettings} from './common.js';
import {notify} from './notice.js';

// What went wrong with the power and capture actions, in the journal (one place for all of them).
const warn = message => console.warn(`João: ${message}`);

const MODE_SCREENSHOT = 0;
const MODE_SCREENCAST = 1;
const LOGOUT_ASK = 0;
const LOGOUT_NO_DIALOG = 1;     // an app with unsaved work still stops it
const COUNTDOWN_SECONDS = 10;
const SKIP_WINDOW_SECONDS = 5;
const SLIDE = 40;
const DURATION = 450;
const DIALOG_PATH = '/org/gnome/SessionManager/EndSessionDialog';
const DIALOG_IFACE = 'org.gnome.SessionManager.EndSessionDialog';

const MAIN = 0, POWER = 1, COUNTDOWN = 2;

// What the search box runs: the page is closing, so there is no bar to count down on and
// Reiniciar and Apagar use GNOME's dialog.
const SYSTEM_RUNS = {
    lock: 'activateLockScreen',
    suspend: 'activateSuspend',
    restart: 'activateRestart',
    poweroff: 'activatePowerOff',
};

function callLogind(method, params, cancellable, done) {
    Gio.DBus.system.call('org.freedesktop.login1', '/org/freedesktop/login1',
        'org.freedesktop.login1.Manager', method, params, null,
        Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION, -1, cancellable, done);
}

function callSession(method, params, done) {
    Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
        'org.gnome.SessionManager', method, params, null,
        Gio.DBusCallFlags.NONE, -1, null, done);
}

// gnome-session's Shutdown and Reboot always ask the shell for its dialog. The countdown already
// asked, so the next request is confirmed at once, unless an app holds the session (unsaved work):
// then the dialog shows, naming it. Returns what undoes this if the request never comes.
function skipNextDialog(signal) {
    const proto = EndSessionDialog.prototype;
    const original = proto.OpenAsync;
    if (!original)
        return () => {};
    let timeoutId = 0;
    const restore = () => {
        proto.OpenAsync = original;
        if (timeoutId)
            GLib.source_remove(timeoutId);
        timeoutId = 0;
    };
    proto.OpenAsync = function (parameters, invocation) {
        restore();
        if (parameters[3].length > 0)
            return original.call(this, parameters, invocation);
        invocation.return_value(null);
        Gio.DBus.session.emit_signal(null, DIALOG_PATH, DIALOG_IFACE, signal, null);
        return undefined;
    };
    timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SKIP_WINDOW_SECONDS, () => {
        timeoutId = 0;
        restore();
        return GLib.SOURCE_REMOVE;
    });
    return restore;
}

export const PowerBar = GObject.registerClass(
class JoaoPowerBar extends St.Widget {
    _init({tooltip, close, closeNow}) {
        super._init({
            style_class: 'pb-bar',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            clip_to_allocation: true,
            reactive: true,
        });
        this._tooltip = tooltip;
        this._close = close;
        this._closeNow = closeNow;
        this._actions = SystemActions.getDefault();
        this._state = MAIN;
        this._countdownId = 0;
        this._recordingId = 0;
        this.buttons = {};

        this._buildMain();
        this._buildPower();
        this._buildCountdown();
        this._layers = [this._mainLayer, this._powerLayer, this._countdownLayer];
        this._powerLayer.hide();
        this._countdownLayer.hide();

        this._bindAvailability();
        this._checkHibernate();
        this._castId = Main.screenshotUI.connect('notify::screencast-in-progress', () => this._syncRecording());
        this._syncRecording();
        this._mappedId = this.connect('notify::mapped', () => {
            if (!this.mapped)
                this.resetState();
        });
        this.connect('destroy', () => this._onDestroy());
    }

    _buildMain() {
        const layer = this._mainLayer = this._layer();
        layer.add_child(this._button('settings', 'preferences-system-symbolic', 'Ajustes', () => this.run('settings')));
        layer.add_child(this._button('capture', 'camera-photo-symbolic', 'Captura', () => this._openScreenshot(MODE_SCREENSHOT)));
        layer.add_child(this._button('record', 'camera-video-symbolic', 'Grabar', () => this._toggleRecording()));
        layer.add_child(new St.Widget({x_expand: true}));
        layer.add_child(this._button('lock', 'system-lock-screen-symbolic', 'Bloquear', () => this.run('lock')));
        layer.add_child(this._button('power', 'system-shutdown-symbolic', 'Energía', () => this._go(POWER), 'pb-power'));
    }

    _buildPower() {
        const layer = this._powerLayer = this._layer();
        const back = this._button('back', 'go-previous-symbolic', null, () => this._go(MAIN), 'pb-back');
        back.accessible_name = 'Volver';
        this._tooltip.attach(back, 'Volver');
        layer.add_child(back);
        layer.add_child(this._button('suspend', 'weather-clear-night-symbolic', 'Suspender', () => this.run('suspend'), 'pb-flex'));
        layer.add_child(this._button('hibernate', 'drive-harddisk-symbolic', 'Hibernar', () => this.run('hibernate'), 'pb-flex'));
        layer.add_child(this._button('restart', 'view-refresh-symbolic', 'Reiniciar', () => this._startCountdown('restart'), 'pb-flex'));
        layer.add_child(this._button('logout', 'system-log-out-symbolic', 'Salir', () => this._startCountdown('logout'), 'pb-flex'));
        layer.add_child(this._button('poweroff', 'system-shutdown-symbolic', 'Apagar', () => this._startCountdown('poweroff'), 'pb-flex pb-danger'));
    }

    _buildCountdown() {
        const layer = this._countdownLayer = new St.Widget({
            style_class: 'pb-count',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        this.add_child(layer);
        // In a fixed layout, so that it empties towards its left edge.
        const track = new St.Widget({x_expand: true});
        this._progress = new St.Widget({style_class: 'pb-progress'});
        track.add_child(this._progress);
        layer.add_child(track);

        const row = new St.BoxLayout({style_class: 'pb-count-row', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._countLabel = new St.Label({style_class: 'pb-count-label', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.buttons.cancel = new St.Button({style_class: 'pb-cancel', label: 'Cancelar', can_focus: true});
        this.buttons.cancel.connect('clicked', () => this._cancelCountdown());
        row.add_child(this._countLabel);
        row.add_child(this.buttons.cancel);
        layer.add_child(row);
    }

    _layer() {
        const box = new St.BoxLayout({style_class: 'pb-layer', x_expand: true});
        this.add_child(box);
        return box;
    }

    _button(id, icon, label, clicked, extraClass = '') {
        const button = new St.Button({
            style_class: `pb-btn ${extraClass}`.trim(),
            can_focus: true,
            accessible_name: label,
            x_expand: extraClass.includes('pb-flex'),
        });
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.icon = new St.Icon({style_class: 'pb-icon', icon_name: icon, x_align: Clutter.ActorAlign.CENTER});
        box.add_child(button.icon);
        if (label) {
            button.text = new St.Label({style_class: 'pb-label', text: label, x_align: Clutter.ActorAlign.CENTER});
            box.add_child(button.text);
        }
        button.set_child(box);
        button.connect('clicked', clicked);
        this.buttons[id] = button;
        return button;
    }

    // Only what this machine and its administrator allow.
    _bindAvailability() {
        for (const [property, id] of [
            ['can-lock-screen', 'lock'],
            ['can-suspend', 'suspend'],
            ['can-restart', 'restart'],
            ['can-power-off', 'poweroff'],
        ])
            this._actions.bind_property(property, this.buttons[id], 'visible', GObject.BindingFlags.SYNC_CREATE);
        // SystemActions hides "logout" with a single local user; the lockdown is what counts here.
        this._lockdown = new Gio.Settings({schema_id: 'org.gnome.desktop.lockdown'});
        this._lockdown.bind('disable-log-out', this.buttons.logout, 'visible',
            Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.INVERT_BOOLEAN);
    }

    // Hidden unless logind says this machine can do it ("challenge" asks for a password).
    _checkHibernate() {
        const button = this.buttons.hibernate;
        button.visible = false;
        this._hibernateCheck = new Gio.Cancellable();
        callLogind('CanHibernate', null, this._hibernateCheck, (bus, res) => {
            try {
                const [answer] = bus.call_finish(res).deepUnpack();
                button.visible = answer === 'yes' || answer === 'challenge';
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    warn(`CanHibernate: ${e.message}`);
            }
        });
    }

    _go(state) {
        if (state === this._state)
            return;
        const forward = state > this._state;
        const from = this._layers[this._state];
        const to = this._layers[state];
        const hadFocus = from.contains(global.stage.key_focus);
        this._state = state;

        from.remove_all_transitions();
        from.ease({
            translation_x: state === COUNTDOWN ? 0 : (forward ? -SLIDE : SLIDE),
            translation_y: state === COUNTDOWN ? -20 : 0,
            opacity: 0,
            duration: DURATION * 0.6,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => from.hide(),
        });

        to.remove_all_transitions();
        to.set({
            translation_x: state === COUNTDOWN ? 0 : (forward ? SLIDE : -SLIDE),
            translation_y: state === COUNTDOWN ? 20 : 0,
            opacity: 0,
        });
        to.show();
        to.ease({
            translation_x: 0,
            translation_y: 0,
            opacity: 255,
            duration: DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
        });
        if (state === POWER)
            this._stagger(to);
        if (hadFocus)
            this._focusIn(state);
    }

    _stagger(layer) {
        layer.get_children().filter(child => child.visible).forEach((child, i) => {
            child.remove_all_transitions();
            child.set({opacity: 0, translation_y: 6});
            child.ease({
                opacity: 255,
                translation_y: 0,
                delay: 40 * i,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
    }

    // The button that had the keyboard is leaving.
    _focusIn(state) {
        const target = {
            [MAIN]: this.buttons.power,
            [POWER]: this.buttons.back,
            [COUNTDOWN]: this.buttons.cancel,
        }[state];
        target.grab_key_focus();
    }

    resetState() {
        this._stopCountdown();
        this._layers.forEach((layer, i) => {
            layer.remove_all_transitions();
            layer.set({translation_x: 0, translation_y: 0, opacity: 255, visible: i === MAIN});
        });
        for (const child of this._powerLayer.get_children()) {
            child.remove_all_transitions();
            child.set({opacity: 255, translation_y: 0});
        }
        this._state = MAIN;
    }

    // The page can be reopened during its fade, and then the bar never left the screen.
    _closeAndReset() {
        this._close();
        this.resetState();
    }

    // ---------- capture and recording ----------

    // The shot is taken as soon as it opens: the page must already be gone, with no fade.
    _openScreenshot(mode) {
        this._closeNow();
        const ui = Main.screenshotUI;
        ui.open(mode).then(() => {
            // No recording on this machine: it returns without opening.
            if (mode === MODE_SCREENCAST && !ui.visible)
                return ui.open(MODE_SCREENSHOT);
            return null;
        }).catch(e => warn(`captura: ${e.message}`));
    }

    _toggleRecording() {
        if (Main.screenshotUI.screencast_in_progress)
            Main.screenshotUI.stopScreencast().catch(e => warn(`grabación: ${e.message}`));
        else
            this._openScreenshot(MODE_SCREENCAST);
    }

    _syncRecording() {
        const button = this.buttons.record;
        const recording = Main.screenshotUI.screencast_in_progress;
        if (this._recordingId)
            GLib.source_remove(this._recordingId);
        this._recordingId = 0;
        if (recording)
            button.add_style_class_name('pb-recording');
        else
            button.remove_style_class_name('pb-recording');
        button.icon.icon_name = recording ? 'media-record-symbolic' : 'camera-video-symbolic';
        if (!recording) {
            button.text.text = 'Grabar';
            return;
        }
        const start = GLib.get_monotonic_time();
        const tick = () => {
            const seconds = Math.floor((GLib.get_monotonic_time() - start) / GLib.USEC_PER_SEC);
            const pad = n => String(n).padStart(2, '0');
            button.text.text = `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
            return GLib.SOURCE_CONTINUE;
        };
        tick();
        this._recordingId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, tick);
    }

    // ---------- countdown ----------

    _startCountdown(action) {
        this._countdownAction = action;
        this._remaining = COUNTDOWN_SECONDS;
        this._updateCountLabel();
        this._go(COUNTDOWN);

        this._progress.remove_all_transitions();
        this._progress.set_size(this.width, this.height);
        this._progress.ease({
            width: 0,
            duration: COUNTDOWN_SECONDS * 1000,
            mode: Clutter.AnimationMode.LINEAR,
        });
        this._countdownId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._remaining--;
            if (this._remaining > 0) {
                this._updateCountLabel();
                return GLib.SOURCE_CONTINUE;
            }
            this._countdownId = 0;
            this._closeAndReset();
            this.activateEndSession(action);
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateCountLabel() {
        const verb = {poweroff: 'Apagando', restart: 'Reiniciando', logout: 'Cerrando sesión'}[this._countdownAction];
        this._countLabel.text = `${verb} en ${this._remaining} s`;
    }

    _stopCountdown() {
        if (this._countdownId)
            GLib.source_remove(this._countdownId);
        this._countdownId = 0;
        this._progress.remove_all_transitions();
    }

    _cancelCountdown() {
        this._stopCountdown();
        if (this._state === COUNTDOWN)
            this._go(POWER);
    }

    // ---------- actions ----------

    // The countdown was the confirmation: no dialog after it.
    activateEndSession(action) {
        if (action === 'logout') {
            this.activateLogout(LOGOUT_NO_DIALOG);
            return;
        }
        const restore = skipNextDialog(action === 'poweroff' ? 'ConfirmedShutdown' : 'ConfirmedReboot');
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

    activateHibernate() {
        callLogind('Hibernate', new GLib.Variant('(b)', [true]), null, (bus, res) => {
            try {
                bus.call_finish(res);
            } catch (e) {
                warn(`Hibernate: ${e.message}`);
                notify('No se pudo hibernar', 'El equipo sigue encendido y no se perdió nada.');
            }
        });
    }

    activateLogout(mode) {
        callSession('Logout', new GLib.Variant('(u)', [mode]), (bus, res) => {
            try {
                bus.call_finish(res);
            } catch (e) {
                warn(`Logout: ${e.message}`);
                notify('No se pudo cerrar la sesión', 'Tus ventanas siguen abiertas.');
            }
        });
    }

    can(id) {
        if (id === 'settings')
            return true;
        return this.buttons[id].visible;
    }

    // The page holds the keyboard: it closes before a dialog or the lock screen.
    run(id) {
        this._closeAndReset();
        if (id === 'settings')
            launchSettings();
        else if (id === 'hibernate')
            this.activateHibernate();
        else if (id === 'logout')
            this.activateLogout(LOGOUT_ASK);
        else
            this._actions[SYSTEM_RUNS[id]]();
    }

    _onDestroy() {
        this.disconnect(this._mappedId);
        this._hibernateCheck.cancel();
        this._stopCountdown();
        if (this._recordingId)
            GLib.source_remove(this._recordingId);
        this._recordingId = 0;
        Main.screenshotUI.disconnect(this._castId);
    }
});
