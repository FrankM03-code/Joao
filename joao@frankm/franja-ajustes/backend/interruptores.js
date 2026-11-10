// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What each switch of the settings strip reads and changes. Every backend has the same shape:
//   on: bool, available: bool, set(on), watch(fn) (fn runs on any outside change).
// Wi-Fi, Bluetooth and dark mode go through GNOME's own quick toggles (sistema/gnome.js): they keep
// running with the top bar hidden, and so the change is exactly the one GNOME's menu would make.
// No molestar and Luz cálida are plain settings; Avión is GNOME's rfkill manager; the microphone
// is the default input of GNOME's mixer (on = muted).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

import {getRfkillManager} from 'resource:///org/gnome/shell/ui/status/rfkill.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {gnome} from '../../sistema/gnome.js';

// One of GNOME's quick toggles. It only flips, so set() clicks it when the state differs.
function mirror(signals, toggle) {
    return {
        get on() {
            return !!toggle?.checked;
        },
        get available() {
            return !!toggle?.visible && toggle.reactive !== false;
        },
        set(on) {
            if (this.available && this.on !== on)
                toggle.emit('clicked', Clutter.BUTTON_PRIMARY);
        },
        watch(fn) {
            for (const prop of ['checked', 'visible', 'reactive'])
                signals.connect(toggle, `notify::${prop}`, fn);
        },
    };
}

function setting(signals, settings, key, inverted = false) {
    return {
        get on() {
            return settings.get_boolean(key) !== inverted;
        },
        available: true,
        set(on) {
            if (this.on !== on)
                settings.set_boolean(key, on !== inverted);
        },
        watch(fn) {
            signals.connect(settings, `changed::${key}`, fn);
        },
    };
}

function airplane(signals) {
    const manager = getRfkillManager();
    return {
        get on() {
            return !!manager.airplane_mode;
        },
        // A hardware switch wins; without rfkill there is nothing to change.
        get available() {
            return typeof manager.airplane_mode === 'boolean' && !manager.hw_airplane_mode;
        },
        set(on) {
            if (this.available && this.on !== on)
                manager.airplane_mode = on;
        },
        watch(fn) {
            for (const prop of ['airplane-mode', 'hw-airplane-mode'])
                signals.connect(manager, `notify::${prop}`, fn);
        },
    };
}

// "Mic. silenciado": on while the default microphone is muted.
function micMuted(signals) {
    const control = getMixerControl();
    const source = () => control.get_default_source();
    let watched = null, notify = null;
    // Each new default microphone gets its handler (all go with signals.disconnectAll()).
    const rewire = () => {
        const now = source();
        if (now && now !== watched)
            signals.connect(now, 'notify::is-muted', () => notify?.());
        watched = now;
        notify?.();
    };
    return {
        get on() {
            return !!source()?.is_muted;
        },
        get available() {
            return !!source();
        },
        set(on) {
            const s = source();
            if (s && s.is_muted !== on)
                s.change_is_muted(on);
        },
        watch(fn) {
            notify = fn;
            signals.connect(control, 'default-source-changed', rewire);
            signals.connect(control, 'state-changed', rewire);
            rewire();
        },
    };
}

// Call once GNOME's indicators exist (whenReady).
export function makeBackends(signals) {
    return {
        'wifi': mirror(signals, gnome.wifiToggle()),
        'bluetooth': mirror(signals, gnome.bluetoothToggle()),
        'dark': mirror(signals, gnome.darkModeToggle()),
        'dnd': setting(signals, new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'}), 'show-banners', true),
        'night-light': setting(signals, new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'}), 'night-light-enabled'),
        'airplane': airplane(signals),
        'mic': micMuted(signals),
    };
}
