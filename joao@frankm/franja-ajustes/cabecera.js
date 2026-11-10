// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The settings strip's header: the time, big and centred, and the date below it.
// The colon is a label of its own so it can blink (phase 5).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import St from 'gi://St';

export const Cabecera = GObject.registerClass(
class JoaoAjustesCabecera extends St.Widget {
    _init() {
        super._init({style_class: 'joao-ajustes-cabecera', layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: false});
        const row = new St.BoxLayout({style_class: 'joao-ajustes-cabecera-fila', x_expand: true,
            orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER});
        const time = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
        this._hours = new St.Label({style_class: 'joao-ajustes-hora'});
        this.colon = new St.Label({style_class: 'joao-ajustes-hora', text: ':'});
        this._minutes = new St.Label({style_class: 'joao-ajustes-hora'});
        time.add_child(this._hours);
        time.add_child(this.colon);
        time.add_child(this._minutes);
        this._date = new St.Label({style_class: 'joao-ajustes-fecha', x_align: Clutter.ActorAlign.CENTER});
        row.add_child(time);
        row.add_child(this._date);
        this.add_child(row);

        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._clock = new GnomeDesktop.WallClock({time_only: true});
        this._clockId = this._clock.connect('notify::clock', () => this._sync());
        this._formatId = this._interface.connect('changed::clock-format', () => this._sync());
        this._sync();
        this.connect('destroy', () => {
            this._clock.disconnect(this._clockId);
            this._interface.disconnect(this._formatId);
            this._clock = null;
        });
    }

    _sync() {
        const now = GLib.DateTime.new_now_local();
        const h24 = this._interface.get_string('clock-format') !== '12h';
        this._hours.text = now.format(h24 ? '%H' : '%-l');
        this._minutes.text = now.format(h24 ? '%M' : '%M %p');
        this._date.text = now.format('%A, %-d de %B');
        this.accessible_name = now.format(h24 ? '%H:%M, %A %-d de %B' : '%-l:%M %p, %A %-d de %B');
    }
});
