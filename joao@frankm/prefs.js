// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// João's preferences.
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {EscenasPage} from './franja/prefsEscenas.js';
import {AjustesPage} from './franja-ajustes/prefsAjustes.js';

export default class JoaoPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'João', icon_name: 'view-grid-symbolic'});
        window.add(page);
        window.set_default_size(600, 780);
        new EscenasPage().fill(window, settings);
        new AjustesPage().fill(window, settings);

        const open = new Adw.PreferencesGroup({title: 'Abrir'});
        page.add(open);
        open.add(this._shortcutRow(settings, 'saved-scenes-shortcut', 'Atajo de la pantalla de escenas guardadas'));
        open.add(this._shortcutRow(settings, 'launcher-today-shortcut', 'Atajo para abrir con el foco en Hoy'));
        open.add(this._shortcutRow(settings, 'launcher-settings-shortcut', 'Atajo para abrir con el foco en el panel del sistema'));
        open.add(this._switchRow(settings, 'replace-super', 'Abrir con la tecla Super', 'Actividades sigue en Super+A'));
        open.add(this._switchRow(settings, 'saved-scenes-on-login', 'Mostrarla al iniciar sesión', ''));

        const ring = new Adw.PreferencesGroup({title: 'Menú del anillo',
            description: 'Clic derecho en el botón del lanzador'});
        page.add(ring);
        ring.add(this._shortcutRow(settings, 'ring-note-shortcut', 'Nota rápida'));
        ring.add(this._shortcutRow(settings, 'ring-clipboard-shortcut', 'Portapapeles'));
        ring.add(this._shortcutRow(settings, 'ring-timer-shortcut', 'Temporizador'));
        ring.add(this._switchRow(settings, 'clipboard-history', 'Guardar el historial del portapapeles',
            'Las 10 últimas copias. Al apagarlo se borran; las fijadas se quedan. Lo que un gestor de contraseñas marca como secreto nunca se guarda'));

        const bar = new Adw.PreferencesGroup({title: 'Barra superior'});
        page.add(bar);
        bar.add(this._switchRow(settings, 'hide-top-bar', 'Ocultar la barra superior de GNOME',
            'Con la barra oculta, la esquina activa de arriba a la izquierda puede dejar de funcionar'));
        bar.add(this._cornerRow(settings));

        const screen = new Adw.PreferencesGroup({title: 'Pantalla'});
        page.add(screen);
        screen.add(this._switchRow(settings, 'system-panel-visible', 'Mostrar el panel del sistema',
            'Si lo apagas, se abre con un botón en la cabecera'));
        screen.add(this._switchRow(settings, 'saved-scenes-suggestions', 'Sugerir una escena según la hora',
            'Se calcula con tu uso en este equipo; no sale nada de aquí'));
        screen.add(this._switchRow(settings, 'saved-scenes-blur', 'Desenfocar el fondo', ''));
        screen.add(this._effectRow(settings));

        const restore = new Adw.PreferencesGroup({title: 'Al abrir una escena'});
        page.add(restore);
        restore.add(this._switchRow(settings, 'restore-reuse-windows', 'Reutilizar ventanas ya abiertas',
            'En vez de abrir otras nuevas'));
        const timeout = new Adw.SpinRow({
            title: 'Tiempo máximo esperando ventanas (segundos)',
            adjustment: new Gtk.Adjustment({lower: 2, upper: 60, step_increment: 1, page_increment: 5}),
        });
        settings.bind('restore-timeout', timeout, 'value', Gio.SettingsBindFlags.DEFAULT);
        restore.add(timeout);

        const tiling = new Adw.PreferencesGroup({title: 'Organizar ventanas'});
        page.add(tiling);
        tiling.add(this._switchRow(settings, 'tiling-activo', 'Colocar ventanas en mitades y cuartos',
            'Arrastra una ventana a un borde o una esquina, o usa los atajos'));
        tiling.add(this._shortcutRow(settings, 'tile-left-shortcut', 'Ir a la izquierda'));
        tiling.add(this._shortcutRow(settings, 'tile-right-shortcut', 'Ir a la derecha'));
        tiling.add(this._shortcutRow(settings, 'tile-up-shortcut', 'Ir arriba o maximizar'));
        tiling.add(this._shortcutRow(settings, 'tile-down-shortcut', 'Ir abajo o devolver el tamaño'));

        const privacy = new Adw.PreferencesGroup({title: 'Micrófono, cámara y pantalla'});
        page.add(privacy);
        privacy.add(this._switchRow(settings, 'privacy-dots', 'Mostrar los puntos arriba', 'Naranja: micrófono. Verde: cámara. Rojo: pantalla'));
        privacy.add(this._switchRow(settings, 'privacy-show-when-panel', 'Mostrar los puntos con la barra visible',
            'La barra de GNOME ya tiene sus propios avisos'));
        privacy.add(this._switchRow(settings, 'privacy-badges', 'Marcar en la franja la escena que los usa', ''));
        privacy.add(this._switchRow(settings, 'privacy-pulse', 'Latido de la insignia', ''));

        const bubble = new Adw.PreferencesGroup({title: 'Notificaciones'});
        page.add(bubble);
        const styles = ['bubble', 'island'];
        const style = new Adw.ComboRow({
            title: 'Dónde avisan',
            subtitle: 'En el botón del lanzador sale aunque la franja esté oculta; nunca arriba',
            model: Gtk.StringList.new(['En la burbuja de la franja', 'En la isla']),
            selected: Math.max(0, styles.indexOf(settings.get_string('notify-style'))),
        });
        style.connect('notify::selected', () => settings.set_string('notify-style', styles[style.selected]));
        bubble.add(style);
        bubble.add(this._switchRow(settings, 'bubble-notifications', 'Animar la burbuja', 'Si no, los avisos solo quedan en la lista'));
        bubble.add(this._switchRow(settings, 'bubble-notify-list', 'Lista al pasar el ratón por la burbuja', ''));
        bubble.add(this._switchRow(settings, 'notify-hide-message-text', 'Ocultar el texto de los mensajes en la línea',
            'Solo dice quién escribe y «nuevo mensaje»'));
        const caption = new Adw.SpinRow({
            title: 'Segundos que dura la línea bajo la burbuja',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 30, step_increment: 1, page_increment: 5}),
        });
        settings.bind('notify-caption-seconds', caption, 'value', Gio.SettingsBindFlags.DEFAULT);
        bubble.add(caption);

        const island = new Adw.PreferencesGroup({title: 'Isla de notificaciones'});
        page.add(island);
        const glass = new Adw.SpinRow({
            title: 'Transparencia del vidrio',
            subtitle: 'Más alto: más blanco y menos transparente',
            digits: 2,
            adjustment: new Gtk.Adjustment({lower: 0.08, upper: 0.6, step_increment: 0.02, page_increment: 0.1}),
        });
        settings.bind('island-glass', glass, 'value', Gio.SettingsBindFlags.DEFAULT);
        island.add(glass);
        island.add(this._switchRow(settings, 'island-blur', 'Desenfocar el fondo', ''));
        island.add(this._switchRow(settings, 'island-auto-contrast', 'Oscurecer el vidrio sobre fondos claros', ''));
        island.add(this._switchRow(settings, 'firefox-as-chat', 'Mostrar las de Firefox como las de un chat',
            'Firefox no dice de qué página vienen: úsalo solo si una única página de chat tiene permiso para avisar'));
        const chatName = new Adw.EntryRow({title: 'Nombre de ese chat'});
        settings.bind('firefox-chat-name', chatName, 'text', Gio.SettingsBindFlags.DEFAULT);
        island.add(chatName);
        island.add(this._switchRow(settings, 'island-expand-on-hover', 'Expandir al pasar el ratón', 'Si no, solo con clic'));
        const lifetime = new Adw.SpinRow({
            title: 'Segundos que dura la píldora',
            adjustment: new Gtk.Adjustment({lower: 2, upper: 30, step_increment: 1, page_increment: 5}),
        });
        settings.bind('island-timeout', lifetime, 'value', Gio.SettingsBindFlags.DEFAULT);
        island.add(lifetime);

        const about = new Adw.PreferencesGroup({title: 'Acerca de'});
        page.add(about);
        about.add(new Adw.ActionRow({title: 'Creado y diseñado por', subtitle: 'Frank Molina'}));
    }

    _effectRow(settings) {
        const effects = ['wave', 'fade', 'none'];
        const row = new Adw.ComboRow({
            title: 'Efecto al abrir',
            subtitle: 'La onda sale de la burbuja de la franja; sin burbuja se usa el fundido',
            model: Gtk.StringList.new(['Onda', 'Fundido', 'Ninguno']),
            selected: Math.max(0, effects.indexOf(settings.get_string('launcher-open-effect'))),
        });
        row.connect('notify::selected', () => settings.set_string('launcher-open-effect', effects[row.selected]));
        return row;
    }

    _cornerRow(settings) {
        const corners = ['top-center', 'top-right', 'top-left', 'bottom-right', 'bottom-left'];
        const row = new Adw.ComboRow({
            title: 'Lugar de los puntos de privacidad',
            model: Gtk.StringList.new(['Arriba al centro', 'Arriba a la derecha', 'Arriba a la izquierda', 'Abajo a la derecha', 'Abajo a la izquierda']),
            selected: Math.max(0, corners.indexOf(settings.get_string('privacy-indicator-corner'))),
        });
        row.connect('notify::selected', () => settings.set_string('privacy-indicator-corner', corners[row.selected]));
        return row;
    }

    _switchRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _shortcutRow(settings, key, title) {
        const row = new Adw.ActionRow({title});
        const label = new Gtk.ShortcutLabel({disabled_text: 'Sin atajo', valign: Gtk.Align.CENTER});
        const button = new Gtk.ToggleButton({label: 'Cambiar', valign: Gtk.Align.CENTER});
        const clear = new Gtk.Button({icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Quitar el atajo'});
        const sync = () => {
            label.accelerator = settings.get_strv(key)[0] ?? '';
        };
        sync();
        settings.connect(`changed::${key}`, sync);
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
}
