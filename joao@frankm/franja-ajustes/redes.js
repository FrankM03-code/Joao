// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The Wi-Fi and Bluetooth view of the settings strip, opened from their tiles: a back button, the
// name and state, a switch, and the list (networks in reach, or the paired devices). A click on a
// network connects to it (a protected one GNOME has not seen asks for the password with its own
// dialog); a click on a device connects or disconnects it. With the radio off, a note instead.
// The lists come from GNOME's own quick settings (the Wi-Fi toggle's networks, the Bluetooth
// toggle's client), so they are exactly the ones GNOME's menu would show.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Switch} from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {launchSettings} from '../sistema/common.js';
import {gnome} from '../sistema/gnome.js';

const MAX_ROWS = 6;
const REFRESH = 2000;   // ms, while open: networks come and go

const WIFI = {
    title: 'Wi‑Fi',
    listTitle: 'Redes disponibles',
    off: 'Activa el Wi‑Fi para ver las redes',
    missing: 'Este equipo no tiene Wi‑Fi',
    link: 'Configuración de Wi‑Fi',
    page: 'wifi',
};
const BLUETOOTH = {
    title: 'Bluetooth',
    listTitle: 'Dispositivos',
    off: 'Activa el Bluetooth para ver dispositivos',
    missing: 'Este equipo no tiene Bluetooth',
    link: 'Configuración de Bluetooth',
    page: 'bluetooth',
};

// The networks of every Wi-Fi card, best first: the one in use, then by signal.
function networks() {
    const toggle = gnome.wifiToggle();
    const list = [];
    for (const item of toggle?._items?.values() ?? []) {
        for (const net of item._networkItems?.keys() ?? []) {
            if (!net.name)
                continue;
            list.push({
                name: net.name,
                active: !!net.is_active,
                secure: !!net.secure,
                strength: net.signal_strength ?? 0,
                icon: net.icon_name || 'network-wireless-symbolic',
                activate: () => net.activate(),
            });
        }
    }
    return list.sort((a, b) => (b.active - a.active) || (b.strength - a.strength)).slice(0, MAX_ROWS);
}

function scanWifi() {
    const toggle = gnome.wifiToggle();
    for (const device of toggle?._items?.keys() ?? [])
        toggle._scanDevice?.(device)?.catch?.(() => {});
}

function btClient() {
    return gnome.bluetoothToggle()?._client ?? null;
}

function devices() {
    const client = btClient();
    if (!client)
        return [];
    return [...client.getDevices()]
        .filter(d => d.connectable !== false)
        .sort((a, b) => (b.connected - a.connected) || (a.alias ?? '').localeCompare(b.alias ?? ''))
        .slice(0, MAX_ROWS);
}

const Fila = GObject.registerClass(
class JoaoAjustesRedFila extends St.Button {
    _init() {
        super._init({style_class: 'joao-ajustes-red-fila', can_focus: true, x_expand: true});
        const box = new St.BoxLayout({style_class: 'joao-ajustes-red-fila-caja', x_expand: true});
        this._icon = new St.Icon({icon_size: 14});
        const ico = new St.Bin({style_class: 'joao-ajustes-red-ico', child: this._icon, y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._name = new St.Label({style_class: 'joao-ajustes-red-nombre'});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._sub = new St.Label({style_class: 'joao-ajustes-red-sub'});
        text.add_child(this._name);
        text.add_child(this._sub);
        this._lock = new St.Icon({style_class: 'joao-ajustes-red-candado', icon_name: 'system-lock-screen-symbolic',
            icon_size: 11, y_align: Clutter.ActorAlign.CENTER});
        this._check = new St.Icon({style_class: 'joao-ajustes-red-check', icon_name: 'object-select-symbolic',
            icon_size: 13, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(ico);
        box.add_child(text);
        box.add_child(this._lock);
        box.add_child(this._check);
        this.set_child(box);
        this.connect('clicked', () => this._onClick?.());
    }

    set_({icon, name, sub, active, secure, onClick}) {
        this._icon.icon_name = icon;
        this._name.text = name;
        this._sub.text = sub;
        this._lock.visible = !!secure;
        this._check.visible = !!active;
        if (active)
            this.add_style_class_name('on');
        else
            this.remove_style_class_name('on');
        this.accessible_name = `${name}, ${sub}`;
        this._onClick = onClick;
    }
});

export const VistaRed = GObject.registerClass({
    Signals: {'back': {}},
}, class JoaoAjustesVistaRed extends St.BoxLayout {
    // @switches: the strip's tiles (their backends switch the radio on and off).
    _init(switches) {
        super._init({style_class: 'joao-ajustes-vista joao-ajustes-red', orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, y_expand: true});
        this._switches = switches;
        this._kind = 'wifi';
        this._busy = new Set();
        this.rows = [];

        const head = new St.BoxLayout({style_class: 'joao-ajustes-red-cabeza', x_expand: true});
        this.backButton = new St.Button({style_class: 'joao-ajustes-atras', can_focus: true, accessible_name: 'Volver',
            y_align: Clutter.ActorAlign.CENTER, child: new St.Icon({icon_name: 'go-previous-symbolic', icon_size: 15})});
        this.backButton.connect('clicked', () => this.emit('back'));
        const title = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._title = new St.Label({style_class: 'joao-ajustes-red-titulo'});
        this._status = new St.Label({style_class: 'joao-ajustes-red-estado'});
        this._status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        title.add_child(this._title);
        title.add_child(this._status);
        this._switch = new Switch(false);
        this._switchButton = new St.Button({style_class: 'joao-ajustes-red-interruptor', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER, child: this._switch});
        this._switchButton.connect('clicked', () => {
            const backend = this._backend;
            if (backend?.available)
                backend.set(!backend.on);
        });
        head.add_child(this.backButton);
        head.add_child(title);
        head.add_child(this._switchButton);
        this.add_child(head);

        this._card = new St.BoxLayout({style_class: 'joao-ajustes-red-lista', orientation: Clutter.Orientation.VERTICAL,
            x_expand: true});
        this._listTitle = new St.Label({style_class: 'joao-ajustes-red-lista-titulo'});
        this._card.add_child(this._listTitle);
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            style_class: 'joao-ajustes-red-filas'});
        this._card.add_child(this._list);
        this._noneLabel = new St.Label({style_class: 'joao-ajustes-red-nada'});
        this._card.add_child(this._noneLabel);
        this.add_child(this._card);

        this._linkLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        const linkBox = new St.BoxLayout({style_class: 'joao-ajustes-enlace-caja'});
        linkBox.add_child(this._linkLabel);
        linkBox.add_child(new St.Icon({icon_name: 'go-next-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER}));
        this._link = new St.Button({style_class: 'joao-ajustes-enlace', can_focus: true, x_align: Clutter.ActorAlign.START,
            child: linkBox});
        this._link.connect('clicked', () => {
            this.emit('back');
            launchSettings(this._text.page);
        });
        this.add_child(this._link);

        this._empty = new St.Label({style_class: 'joao-ajustes-red-vacio', x_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.CENTER});
        this._empty.clutter_text.line_wrap = true;
        this._emptyBox = new St.Bin({style_class: 'joao-ajustes-red-vacio-caja', x_expand: true, child: this._empty});
        this.add_child(this._emptyBox);

        this.rows = [head, this._card, this._link, this._emptyBox];
        this._ids = [];
        this.connect('destroy', () => this.stop());
    }

    get _text() {
        return this._kind === 'wifi' ? WIFI : BLUETOOTH;
    }

    get _backend() {
        return this._switches.backends?.[this._kind] ?? null;
    }

    // Opened for @kind ('wifi' or 'bluetooth'): fills it and keeps it current until stop().
    start(kind) {
        this.stop();
        this._kind = kind;
        this._title.text = this._text.title;
        this._listTitle.text = this._text.listTitle;
        this._linkLabel.text = this._text.link;
        const sw = this._switches.switches[kind];
        if (sw)
            this._ids.push([sw, sw.connect('toggled', () => this.refresh())]);
        const client = btClient();
        if (kind === 'bluetooth' && client) {
            this._ids.push([client, client.connect('devices-changed', () => this.refresh())]);
            this._ids.push([client, client.connect('notify::active', () => this.refresh())]);
        }
        if (kind === 'wifi')
            scanWifi();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this.refresh();
    }

    stop() {
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    refresh() {
        const backend = this._backend;
        const available = !!backend?.available;
        const on = available && backend.on;
        this._switch.state = on;
        this._switchButton.reactive = available;
        this._switchButton.opacity = available ? 255 : 110;
        this._switchButton.accessible_name = `${this._text.title}: ${on ? 'activado' : 'desactivado'}`;

        const items = !on ? [] : this._kind === 'wifi' ? this._wifiItems() : this._btItems();
        if (!available)
            this._status.text = this._kind === 'wifi' ? 'No disponible' : 'No disponible';
        else if (!on)
            this._status.text = 'Apagado';
        else {
            const active = items.find(i => i.active);
            this._status.text = active ? `Conectado a ${active.name}`
                : this._kind === 'wifi' ? 'Activado, sin conexión' : 'Activado, sin conexión';
        }

        this._card.visible = this._link.visible = on;
        this._emptyBox.visible = !on;
        this._empty.text = available ? this._text.off : this._text.missing;

        const rows = this._list.get_children();
        while (rows.length < items.length) {
            const row = new Fila();
            this._list.add_child(row);
            rows.push(row);
        }
        rows.forEach((row, i) => {
            row.visible = i < items.length;
            if (row.visible)
                row.set_(items[i]);
        });
        this._noneLabel.visible = on && items.length === 0;
        this._noneLabel.text = this._kind === 'wifi' ? 'Buscando redes…' : 'No hay dispositivos emparejados';
    }

    _wifiItems() {
        return networks().map(n => ({
            icon: n.icon,
            name: n.name,
            sub: n.active ? 'Conectado' : n.secure ? 'Protegida' : 'Abierta',
            active: n.active,
            secure: n.secure,
            onClick: () => {
                if (!n.active)
                    n.activate();
            },
        }));
    }

    _btItems() {
        const client = btClient();
        return devices().map(d => {
            const path = d.get_object_path();
            const busy = this._busy.has(path);
            return {
                icon: d.icon || 'bluetooth-active-symbolic',
                name: d.alias || d.name || 'Dispositivo',
                sub: busy ? (d.connected ? 'Desconectando…' : 'Conectando…') : d.connected ? 'Conectado' : 'Desconectado',
                active: d.connected,
                secure: false,
                onClick: async () => {
                    if (this._busy.has(path) || !client)
                        return;
                    this._busy.add(path);
                    this.refresh();
                    try {
                        await client.toggleDevice(d);
                    } finally {
                        this._busy.delete(path);
                        this.refresh();
                    }
                },
            };
        });
    }
});
