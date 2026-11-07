// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The top of the page: time and date on the left, the search box centered on the screen,
// and on the right a chip with the network, volume and battery icons GNOME would show in its bar.
// What is in use (screen, microphone, camera) is told by the launcher button's ring.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gnome, Signals, whenReady} from '../sistema/gnome.js';

const SEARCH_WIDTH = 560;
const SIDE_ROOM = 300;    // what the clock and the chip need on each side of the search box

export const LauncherHeader = GObject.registerClass(
class JoaoLauncherHeader extends St.Widget {
    _init({tooltip, onSection, onFold}) {
        super._init({style_class: 'escenas-full-header', layout_manager: new Clutter.BinLayout()});

        this.clock = new St.Button({
            style_class: 'escenas-full-clock',
            can_focus: true,
            accessible_name: 'Hora y fecha: ir a Hoy',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const clockBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this._time = new St.Label({style_class: 'escenas-full-time'});
        this._date = new St.Label({style_class: 'escenas-full-date'});
        clockBox.add_child(this._time);
        clockBox.add_child(this._date);
        this.clock.set_child(clockBox);
        this.clock.connect('clicked', () => onSection('today'));
        tooltip.attach(this.clock, 'Ir a Hoy');
        this.add_child(this.clock);

        this.entry = new St.Entry({
            style_class: 'escenas-saved-search',
            hint_text: 'Buscar escenas, apps o ajustes…',
            can_focus: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            primary_icon: new St.Icon({style_class: 'escenas-saved-search-icon', icon_name: 'system-search-symbolic'}),
        });
        this.add_child(this.entry);

        const status = new St.BoxLayout({
            style_class: 'escenas-full-status',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(status);

        this.chip = new St.Button({
            style_class: 'escenas-full-chip',
            can_focus: true,
            accessible_name: 'Estado del sistema: ir al panel del sistema',
            y_align: Clutter.ActorAlign.CENTER,
        });
        tooltip.attach(this.chip, 'Panel del sistema');
        const chipBox = new St.BoxLayout({style_class: 'escenas-full-chip-box'});
        this._netIcon = new St.Icon({style_class: 'escenas-full-chip-icon', visible: false});
        this._volIcon = new St.Icon({style_class: 'escenas-full-chip-icon', visible: false});
        this._batIcon = new St.Icon({style_class: 'escenas-full-chip-icon', visible: false});
        this._batLabel = new St.Label({style_class: 'escenas-full-chip-label', visible: false, y_align: Clutter.ActorAlign.CENTER});
        [this._netIcon, this._volIcon, this._batIcon, this._batLabel].forEach(a => chipBox.add_child(a));
        this.chip.set_child(chipBox);
        this.chip.connect('clicked', () => onSection('settings'));
        status.add_child(this.chip);

        // Only when the panel does not fit or was turned off in the preferences.
        this.foldButton = new St.Button({
            style_class: 'escenas-full-fold',
            can_focus: true,
            visible: false,
            accessible_name: 'Mostrar u ocultar el panel del sistema',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'sidebar-show-right-symbolic', icon_size: 16}),
        });
        this.foldButton.connect('clicked', () => onFold());
        tooltip.attach(this.foldButton, 'Panel del sistema');
        status.add_child(this.foldButton);

        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._wallClock = new GnomeDesktop.WallClock();
        this._signals = new Signals();
        this._signals.connect(this._wallClock, 'notify::clock', () => this.syncClock());
        this._signals.connect(this._interface, 'changed::clock-format', () => this.syncClock());
        this.syncClock();
        this._cancelReady = whenReady(() => this._watch());
        this.connect('destroy', () => this._onDestroy());
    }

    place(width, scale) {
        this.width = width;
        this.entry.width = Math.min(SEARCH_WIDTH * scale, width - 2 * SIDE_ROOM * scale);
    }

    syncClock() {
        const now = GLib.DateTime.new_now_local();
        const h24 = this._interface.get_string('clock-format') !== '12h';
        this._time.text = now.format(h24 ? '%H:%M' : '%l:%M %p').trim();
        this._date.text = now.format('%A, %-d de %B');
    }

    _watch() {
        const s = this._signals;
        const flags = GObject.BindingFlags.SYNC_CREATE;
        const net = gnome.networkIcon();
        s.bind(net, 'icon-name', this._netIcon, 'icon-name', flags);
        s.bind(net, 'visible', this._netIcon, 'visible', flags);
        const volume = gnome.volumeIcon();
        s.bind(volume, 'icon-name', this._volIcon, 'icon-name', flags);
        s.bind(volume, 'visible', this._volIcon, 'visible', flags);
        // Battery only when there is one (GNOME's power toggle is shown only then).
        const power = gnome.powerToggle();
        s.bind(gnome.batteryIcon(), 'icon-name', this._batIcon, 'icon-name', flags);
        s.bind(gnome.batteryLabel(), 'text', this._batLabel, 'text', flags);
        s.bind(power, 'visible', this._batIcon, 'visible', flags);
        s.bind(power, 'visible', this._batLabel, 'visible', flags);
    }

    _onDestroy() {
        this._cancelReady();
        this._signals.disconnectAll();
        this._wallClock = null;
    }
});
