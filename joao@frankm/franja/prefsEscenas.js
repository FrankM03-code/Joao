// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Preferences of the scenes: auto-hide, how many thumbnails, which side, keyboard shortcuts.
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

export class EscenasPage {
    fill(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Escenas', icon_name: 'view-grid-symbolic'});
        window.add(page);

        const general = new Adw.PreferencesGroup({title: 'General'});
        page.add(general);
        const mode = new Adw.SwitchRow({title: 'Modo escenas',
            subtitle: 'Agrupa las ventanas en escenas y muestra la franja lateral'});
        settings.bind('modo-activo', mode, 'active', Gio.SettingsBindFlags.DEFAULT);
        general.add(mode);

        const strip = new Adw.PreferencesGroup({title: 'Franja lateral'});
        page.add(strip);
        const hide = new Adw.SwitchRow({title: 'Ocultar automáticamente',
            subtitle: 'Cuando una ventana la tapa, está maximizada o en pantalla completa. Vuelve al llevar el puntero al borde'});
        settings.bind('ocultar-automatico', hide, 'active', Gio.SettingsBindFlags.DEFAULT);
        strip.add(hide);

        const maxCards = new Adw.SpinRow({title: 'Máximo de tarjetas',
            subtitle: 'Estilo tarjeta. Las escenas más antiguas no se muestran',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 10, step_increment: 1})});
        settings.bind('max-tarjetas', maxCards, 'value', Gio.SettingsBindFlags.DEFAULT);
        strip.add(maxCards);
        const max = new Adw.SpinRow({title: 'Máximo de miniaturas en abanico',
            subtitle: 'Estilo abanico. Las escenas más antiguas no se muestran',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 10, step_increment: 1})});
        settings.bind('max-miniaturas', max, 'value', Gio.SettingsBindFlags.DEFAULT);
        strip.add(max);

        const styles = ['abanico', 'tarjeta'];
        const style = new Adw.ComboRow({title: 'Estilo de las miniaturas',
            subtitle: 'Abanico: las ventanas apiladas. Tarjeta: cada escena en su tarjeta de vidrio',
            model: Gtk.StringList.new(['Abanico', 'Tarjeta'])});
        style.selected = Math.max(0, styles.indexOf(settings.get_string('estilo-miniaturas')));
        style.connect('notify::selected', () => settings.set_string('estilo-miniaturas', styles[style.selected]));
        strip.add(style);

        const pile = new Adw.PreferencesGroup({title: 'Girar la pila',
            description: 'Elegir qué ventana queda delante en una miniatura con varias ventanas (estilo abanico)'});
        page.add(pile);
        const wheel = new Adw.SwitchRow({title: 'Girar la pila con la rueda del ratón'});
        settings.bind('girar-con-rueda', wheel, 'active', Gio.SettingsBindFlags.DEFAULT);
        pile.add(wheel);
        const arrows = new Adw.SwitchRow({title: 'Mostrar flechas al pasar el ratón'});
        settings.bind('flechas-pila', arrows, 'active', Gio.SettingsBindFlags.DEFAULT);
        pile.add(arrows);
        const invert = new Adw.SwitchRow({title: 'Invertir dirección de la rueda'});
        settings.bind('invertir-rueda', invert, 'active', Gio.SettingsBindFlags.DEFAULT);
        pile.add(invert);

        const sides = ['izquierda', 'derecha'];
        const side = new Adw.ComboRow({title: 'Lado de la pantalla',
            model: Gtk.StringList.new(['Izquierda', 'Derecha'])});
        side.selected = Math.max(0, sides.indexOf(settings.get_string('lado')));
        side.connect('notify::selected', () => settings.set_string('lado', sides[side.selected]));
        strip.add(side);

        const colors = ['oscuro', 'claro'];
        const color = new Adw.ComboRow({title: 'Color de la franja',
            model: Gtk.StringList.new(['Oscuro transparente', 'Claro'])});
        color.selected = Math.max(0, colors.indexOf(settings.get_string('color-franja')));
        color.connect('notify::selected', () => settings.set_string('color-franja', colors[color.selected]));
        strip.add(color);

        const bubble = new Adw.SwitchRow({title: 'Mostrar la burbuja de apps',
            subtitle: 'Botón redondo bajo la franja que abre el cajón de apps'});
        settings.bind('apps-bubble-visible', bubble, 'active', Gio.SettingsBindFlags.DEFAULT);
        strip.add(bubble);

        const stage = new Adw.PreferencesGroup({title: 'Escena activa'});
        page.add(stage);
        const arrange = new Adw.SwitchRow({title: 'Ordenar ventanas lado a lado',
            subtitle: 'Al juntar ventanas en una escena se reparten el ancho por igual; al quedar sola, cada una vuelve a su tamaño. Si colocaste alguna a mano en una mitad o un cuarto, la escena no se reparte'});
        settings.bind('ordenar-ventanas', arrange, 'active', Gio.SettingsBindFlags.DEFAULT);
        stage.add(arrange);

        const keys = new Adw.PreferencesGroup({title: 'Atajos de teclado',
            description: 'Pulsa «Cambiar» y luego la combinación. Esc cancela, Retroceso lo borra'});
        page.add(keys);
        keys.add(this._shortcutRow(settings, 'atajo-alternar', 'Encender o apagar el modo escenas'));
        keys.add(this._shortcutRow(settings, 'atajo-separar', 'Sacar la ventana enfocada a una escena propia'));
    }

    _shortcutRow(settings, key, title) {
        const row = new Adw.ActionRow({title});
        const label = new Gtk.ShortcutLabel({disabled_text: 'Sin atajo', valign: Gtk.Align.CENTER});
        const button = new Gtk.ToggleButton({label: 'Cambiar', valign: Gtk.Align.CENTER});
        row.add_suffix(label);
        row.add_suffix(button);
        const show = () => {
            label.accelerator = settings.get_strv(key)[0] ?? '';
        };
        show();
        settings.connect(`changed::${key}`, show);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (c, keyval, keycode, state) => {
            if (!button.active)
                return false;
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (!mods && keyval === Gdk.KEY_Escape) {
                button.active = false;
                return true;
            }
            if (!mods && keyval === Gdk.KEY_BackSpace) {
                settings.set_strv(key, []);
                button.active = false;
                return true;
            }
            if (!Gtk.accelerator_valid(keyval, mods) || !mods)
                return true;
            settings.set_strv(key, [Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods)]);
            button.active = false;
            return true;
        });
        button.add_controller(controller);
        button.connect('toggled', () => {
            button.label = button.active ? 'Pulsa el atajo…' : 'Cambiar';
            if (button.active)
                button.grab_focus();
        });
        return row;
    }
}
