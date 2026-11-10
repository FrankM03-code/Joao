// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The foot of the settings view, under a thin line: the "Ajustes" pill (opens Settings), the battery
// ("86 % · 4 h", from UPower's display device; not on a desktop) and the "Bloquear" pill. With
// animations on and the strip on screen, the battery beats softly only while charging.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import {getDefault as systemActions} from 'resource:///org/gnome/shell/misc/systemActions.js';

import {launchSettings} from '../sistema/common.js';
import {animations} from './iconosAnimados.js';

const BUS = 'org.freedesktop.UPower';
const PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const IFACE = 'org.freedesktop.UPower.Device';
const CHARGING = 1, FULL = 4, PENDING_CHARGE = 5;
const PULSE = 1100;

function duration(seconds) {
    if (!seconds || seconds <= 0)
        return null;
    const minutes = Math.round(seconds / 60);
    const h = Math.floor(minutes / 60), m = minutes % 60;
    if (h === 0)
        return `${m} min`;
    return m >= 10 ? `${h} h ${m} min` : `${h} h`;
}

export const Bateria = GObject.registerClass(
class JoaoAjustesBateria extends St.BoxLayout {
    // @onSettings and @onLock run before Settings opens or the screen locks (the strip goes).
    _init({onSettings, onLock}) {
        super._init({style_class: 'joao-ajustes-pie', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.add_child(new St.Widget({style_class: 'joao-ajustes-pie-linea', x_expand: true}));
        const row = new St.BoxLayout({style_class: 'joao-ajustes-bateria', x_expand: true});
        this.add_child(row);
        this._battery = new St.BoxLayout({style_class: 'joao-ajustes-bateria-info', visible: false});
        this._icon = new St.Icon({icon_name: 'battery-good-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        this._label = new St.Label({style_class: 'joao-ajustes-bateria-texto', y_align: Clutter.ActorAlign.CENTER});
        this._battery.add_child(this._icon);
        this._battery.add_child(this._label);
        this._gear = this._pill('org.gnome.Settings-symbolic', 'Ajustes', () => {
            onSettings?.();
            launchSettings();
        });
        row.add_child(this._gear);
        this._battery.x_expand = true;
        this._battery.x_align = Clutter.ActorAlign.CENTER;
        row.add_child(this._battery);
        row.add_child(new St.Widget({x_expand: true}));
        this._lock = this._pill('system-lock-screen-symbolic', 'Bloquear', () => {
            onLock?.();
            systemActions().activateLockScreen();
        });
        row.add_child(this._lock);
        this._looping = false;
        this._charging = false;

        this._cancellable = new Gio.Cancellable();
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null, BUS, PATH, IFACE,
            this._cancellable, (o, res) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`João: UPower: ${e.message}`);
                    return;
                }
                this._proxyId = this._proxy.connect('g-properties-changed', () => this._sync());
                this._sync();
            });
        this.connect('destroy', () => {
            this._cancellable.cancel();
            if (this._proxyId)
                this._proxy.disconnect(this._proxyId);
        });
    }

    _pill(icon, text, onClick) {
        const box = new St.BoxLayout({style_class: 'joao-ajustes-pildora-caja'});
        box.add_child(new St.Icon({icon_name: icon, icon_size: 13, y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5})}));
        box.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
        const button = new St.Button({style_class: 'joao-ajustes-pildora', can_focus: true, accessible_name: text,
            y_align: Clutter.ActorAlign.CENTER, child: box});
        button.connect('clicked', onClick);
        return button;
    }

    _get(name) {
        return this._proxy?.get_cached_property(name)?.unpack() ?? null;
    }

    _sync() {
        const present = !!this._get('IsPresent');
        this._battery.visible = present;
        if (!present) {
            this._charging = false;
            this._syncLoop();
            return;
        }
        const percent = Math.round(this._get('Percentage') ?? 0);
        const state = this._get('State');
        this._charging = state === CHARGING || state === PENDING_CHARGE;
        const icon = this._get('IconName');
        if (icon)
            this._icon.icon_name = icon;
        let left = null;
        if (state === CHARGING)
            left = duration(this._get('TimeToFull'));
        else if (state !== FULL)
            left = duration(this._get('TimeToEmpty'));
        this._label.text = left ? `${percent} % · ${left}` : `${percent} %`;
        this.accessible_name = `Batería ${this._label.text}${this._charging ? ', cargando' : ''}`;
        this._syncLoop();
    }

    looping(on) {
        this._looping = on;
        this._syncLoop();
    }

    _syncLoop() {
        const pulse = this._looping && animations() && this._charging && this._battery.visible;
        if (pulse !== this._pulsing) {
            this._pulsing = pulse;
            this._icon.remove_all_transitions();
            this._icon.set({opacity: 255, scale_x: 1, scale_y: 1});
            if (pulse) {
                this._icon.ease({opacity: 150, scale_x: 1.12, scale_y: 1.12, duration: PULSE, repeatCount: -1,
                    autoReverse: true, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE});
            }
        }
    }
});
