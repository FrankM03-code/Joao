// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The switches. Wi-Fi, Bluetooth and dark mode mirror GNOME's own quick toggles. The rest
// have none that is always there, so they go to the setting or to the service: GNOME has no
// toggle for "No molestar", and shows the others only when it finds the hardware for them.
// Right click opens the matching page of Settings.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {getRfkillManager} from 'resource:///org/gnome/shell/ui/status/rfkill.js';

import {gnome, Signals, whenReady} from './gnome.js';
import {launchSettings} from './common.js';

const DEFS = [
    ['wifi', 'Wi‑Fi', 'network-wireless-symbolic', 'wifi'],
    ['bluetooth', 'Bluetooth', 'bluetooth-active-symbolic', 'bluetooth'],
    ['dark', 'Modo oscuro', 'dark-mode-symbolic', 'background'],
    ['dnd', 'No molestar', 'notifications-disabled-symbolic', 'notifications'],
    ['night', 'Luz nocturna', 'night-light-symbolic', 'display'],
    ['airplane', 'Modo avión', 'airplane-mode-symbolic', 'wifi'],
    ['awake', 'Modo activo', 'weather-clear-symbolic', 'power'],
];
const COLUMNS = 2;
const onOff = on => (on ? 'Activado' : 'Desactivado');

const Toggle = GObject.registerClass(
class JoaoSystemToggle extends St.Button {
    _init(title, iconName) {
        super._init({style_class: 'escenas-full-toggle', can_focus: true, x_expand: true, accessible_name: title});
        const box = new St.BoxLayout({style_class: 'escenas-full-toggle-box', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({icon_name: iconName, icon_size: 15, y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._subtitle = new St.Label({style_class: 'escenas-full-toggle-subtitle'});
        this._subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const name = new St.Label({style_class: 'escenas-full-toggle-title', text: title});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(name);
        text.add_child(this._subtitle);
        box.add_child(this._icon);
        box.add_child(text);
        this.set_child(box);
    }

    show_(checked, subtitle, available = true) {
        this.checked = checked && available;
        // Off but not dead: the right click still opens its page of Settings. The contents
        // only, so the ring that the search box lights up is seen in full.
        this.get_child().opacity = available ? 255 : 130;
        this.available = available;
        this._subtitle.text = available ? subtitle : 'No disponible';
    }

    setIcon(name) {
        if (name)
            this._icon.icon_name = name;
    }

    get subtitle() {
        return this._subtitle.text;
    }
});

export const SystemToggles = GObject.registerClass(
class JoaoSystemToggles extends St.Widget {
    _init({tooltip, close, settings}) {
        const layout = new Clutter.GridLayout({column_homogeneous: true});
        super._init({style_class: 'escenas-full-toggles', layout_manager: layout, x_expand: true});
        this.connect('style-changed', () => {
            const node = this.get_theme_node();
            layout.column_spacing = node.get_length('-joao-gap');
            layout.row_spacing = node.get_length('-joao-gap');
        });
        this.toggles = {};
        DEFS.forEach(([id, title, icon, page], i) => {
            const toggle = new Toggle(title, icon);
            toggle.connect('button-press-event', (a, event) => {
                if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                    return Clutter.EVENT_PROPAGATE;
                close();
                launchSettings(page);
                return Clutter.EVENT_STOP;
            });
            tooltip.attach(toggle, `${title} · clic derecho: abrir en Ajustes`);
            // Alone on its row: the whole width.
            const span = i === DEFS.length - 1 && i % COLUMNS === 0 ? COLUMNS : 1;
            layout.attach(toggle, i % COLUMNS, Math.floor(i / COLUMNS), span, 1);
            this.toggles[id] = toggle;
        });

        this._signals = new Signals();
        this._settings = settings;
        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._color = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
        this._cancelReady = whenReady(() => this._watch());
        this.connect('destroy', () => this._onDestroy());
    }

    _mirror(ours, theirs) {
        const sync = () => {
            const available = !!theirs?.visible && theirs.reactive !== false;
            ours.show_(!!theirs?.checked, theirs?.subtitle || onOff(!!theirs?.checked), available);
            ours.setIcon(theirs?.icon_name);
        };
        for (const prop of ['checked', 'subtitle', 'visible', 'reactive', 'icon-name'])
            this._signals.connect(theirs, `notify::${prop}`, sync);
        this._signals.connect(ours, 'clicked', () => {
            if (ours.available)
                theirs.emit('clicked', Clutter.BUTTON_PRIMARY);
        });
        sync();
    }

    _switch(toggle, settings, key, inverted) {
        const on = () => settings.get_boolean(key) !== inverted;
        const sync = () => toggle.show_(on(), onOff(on()));
        this._signals.connect(settings, `changed::${key}`, sync);
        this._signals.connect(toggle, 'clicked', () => settings.set_boolean(key, !settings.get_boolean(key)));
        sync();
    }

    _watch() {
        this._mirror(this.toggles.wifi, gnome.wifiToggle());
        this._mirror(this.toggles.bluetooth, gnome.bluetoothToggle());
        this._mirror(this.toggles.dark, gnome.darkModeToggle());
        this._switch(this.toggles.dnd, this._notifications, 'show-banners', true);
        this._switch(this.toggles.night, this._color, 'night-light-enabled', false);
        this._switch(this.toggles.awake, this._settings, 'keep-awake', false);

        const airplane = this.toggles.airplane;
        const manager = getRfkillManager();
        const syncAirplane = () => {
            const on = !!manager.airplane_mode;
            const hardware = !!manager.hw_airplane_mode;
            airplane.show_(on, hardware ? 'Por interruptor del equipo' : onOff(on), typeof manager.airplane_mode === 'boolean' && !hardware);
        };
        for (const prop of ['airplane-mode', 'hw-airplane-mode', 'show-airplane-mode'])
            this._signals.connect(manager, `notify::${prop}`, syncAirplane);
        this._signals.connect(airplane, 'clicked', () => {
            if (airplane.available)
                manager.airplane_mode = !manager.airplane_mode;
        });
        syncAirplane();
    }

    // By signal: the parent's destruction does not call destroy() on its children.
    _onDestroy() {
        this._cancelReady();
        this._signals.disconnectAll();
    }
});
