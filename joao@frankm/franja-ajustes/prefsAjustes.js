// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Preferences of the settings strip: on or off, its shortcuts, which switches and in what order,
// and the modes.
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

// The same names as franja-ajustes/interruptores.js (that file runs in the shell, not here).
const SWITCHES = {
    'wifi': 'Wi‑Fi',
    'bluetooth': 'Bluetooth',
    'dark': 'Oscuro',
    'dnd': 'No molestar',
    'night-light': 'Luz cálida',
    'airplane': 'Avión',
};

function shortcutRow(settings, key, title, subtitle = '') {
    const row = new Adw.ActionRow({title, subtitle});
    const label = new Gtk.ShortcutLabel({disabled_text: 'Sin atajo', valign: Gtk.Align.CENTER});
    const button = new Gtk.ToggleButton({label: 'Cambiar', valign: Gtk.Align.CENTER});
    const clear = new Gtk.Button({icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Quitar el atajo'});
    const sync = () => {
        label.accelerator = settings.get_strv(key)[0] ?? '';
    };
    sync();
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    clear.connect('clicked', () => settings.set_strv(key, []));
    const controller = new Gtk.EventControllerKey();
    controller.connect('key-pressed', (c, keyval, keycode, state) => {
        if (!button.active)
            return Gdk.EVENT_PROPAGATE;
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        if (keyval === Gdk.KEY_Escape) {
            button.active = false;
            return Gdk.EVENT_STOP;
        }
        if (!Gtk.accelerator_valid(keyval, mods) || !mods)
            return Gdk.EVENT_STOP;
        settings.set_strv(key, [Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods)]);
        button.active = false;
        return Gdk.EVENT_STOP;
    });
    button.add_controller(controller);
    button.connect('toggled', () => {
        button.label = button.active ? 'Pulsa el atajo…' : 'Cambiar';
    });
    row.add_suffix(label);
    row.add_suffix(button);
    row.add_suffix(clear);
    return row;
}

export class AjustesPage {
    fill(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Franja de ajustes', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        const general = new Adw.PreferencesGroup({title: 'Franja de ajustes',
            description: 'Al lado contrario de la franja de escenas. Reserva su espacio: las ventanas maximizadas terminan antes de ella'});
        page.add(general);
        const enabled = new Adw.SwitchRow({title: 'Mostrar la franja de ajustes',
            subtitle: 'Sustituye al menú de ajustes rápidos de GNOME mientras está activa'});
        settings.bind('settings-strip-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        general.add(enabled);
        general.add(shortcutRow(settings, 'settings-strip-shortcut', 'Mostrar u ocultar la franja'));
        general.add(shortcutRow(settings, 'settings-strip-power-shortcut', 'Abrir la vista Energía',
            'Mayús+Super+Esc ya lo usa GNOME para salir de la captura de entrada'));

        this._switches = new Adw.PreferencesGroup({title: 'Interruptores',
            description: 'Los que se muestran y su orden (hasta seis, en dos filas de tres)'});
        page.add(this._switches);
        this._settings = settings;
        this._rows = [];
        this._fillSwitches();
        const id = settings.connect('changed::settings-strip-toggles', () => this._fillSwitches());
        page.connect('destroy', () => settings.disconnect(id));

        const modes = new Adw.PreferencesGroup({title: 'Modos',
            description: 'Clic en un modo para aplicarlo; clic derecho para renombrarlo, actualizarlo o eliminarlo'});
        page.add(modes);
        const modesOn = new Adw.SwitchRow({title: 'Mostrar la sección Modos'});
        settings.bind('modes-enabled', modesOn, 'active', Gio.SettingsBindFlags.DEFAULT);
        modes.add(modesOn);
        const reset = new Adw.ActionRow({title: 'Volver a los cuatro modos iniciales',
            subtitle: 'Trabajo, Reunión, Noche y Cine. Se pierden los modos creados'});
        const resetButton = new Gtk.Button({label: 'Restablecer', valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action']});
        resetButton.connect('clicked', () => {
            settings.reset('modes');
            settings.reset('active-mode');
        });
        reset.add_suffix(resetButton);
        modes.add(reset);
    }

    _order() {
        const order = this._settings.get_strv('settings-strip-toggles').filter(id => id in SWITCHES);
        return order;
    }

    _fillSwitches() {
        this._rows.forEach(row => this._switches.remove(row));
        this._rows = [];
        const shown = this._order();
        const all = [...shown, ...Object.keys(SWITCHES).filter(id => !shown.includes(id))];
        all.forEach(id => {
            const on = shown.includes(id);
            const row = new Adw.ActionRow({title: SWITCHES[id]});
            const check = new Gtk.Switch({active: on, valign: Gtk.Align.CENTER});
            check.connect('notify::active', () => {
                const order = this._order().filter(x => x !== id);
                if (check.active)
                    order.push(id);
                this._settings.set_strv('settings-strip-toggles', order);
            });
            const index = shown.indexOf(id);
            const up = new Gtk.Button({icon_name: 'go-up-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Subir',
                sensitive: on && index > 0, css_classes: ['flat']});
            const down = new Gtk.Button({icon_name: 'go-down-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Bajar',
                sensitive: on && index < shown.length - 1, css_classes: ['flat']});
            const move = step => {
                const order = this._order();
                const i = order.indexOf(id);
                const j = i + step;
                if (i < 0 || j < 0 || j >= order.length)
                    return;
                [order[i], order[j]] = [order[j], order[i]];
                this._settings.set_strv('settings-strip-toggles', order);
            };
            up.connect('clicked', () => move(-1));
            down.connect('clicked', () => move(1));
            row.add_suffix(up);
            row.add_suffix(down);
            row.add_suffix(check);
            this._switches.add(row);
            this._rows.push(row);
        });
    }
}
