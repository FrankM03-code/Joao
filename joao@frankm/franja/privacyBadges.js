// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The mark on a strip thumbnail whose app uses the microphone, the camera or the screen: a frame
// in the device's colour and a beating badge per device. The thumbnail decides where it goes and
// how its label reads; this only draws. Thumbnails are rebuilt often, so a mark present at birth
// does not animate in.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {DEVICE_INFO, privacyMonitor} from '../privacidad/privacyMonitor.js';
import {canCut, cut, cutLabel, goToApp} from '../privacidad/stopActions.js';

const BEAT = 1600;
const BEAT_GROWTH = 40 / 28;    // the halo goes from the badge's edge to 6 px beyond it
const APPEAR = 200;
const OUT = 10;
const CUT_NAMES = {microphone: true, screen: true};

const HaloBadge = GObject.registerClass(
class JoaoPrivacyBadge extends St.Button {
    _init(device, name, pulse) {
        super._init({
            style_class: 'joao-privacy-badge',
            can_focus: false,
            reactive: true,
            accessible_name: name,
        });
        const layer = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this.halo = new St.Widget({style_class: `joao-privacy-badge-halo ${device}`, x_expand: true, y_expand: true});
        this.halo.set_pivot_point(0.5, 0.5);
        layer.add_child(this.halo);
        layer.add_child(new St.Bin({
            style_class: `joao-privacy-badge-face ${device}`,
            x_expand: true,
            y_expand: true,
            child: new St.Icon({icon_name: DEVICE_INFO[device].icon, icon_size: 13}),
        }));
        this.set_child(layer);
        this.setPulse(pulse);
    }

    setPulse(on) {
        this.halo.remove_all_transitions();
        // Without animations ease() would turn a repeating transition into a busy loop.
        if (on && St.Settings.get().enable_animations) {
            this.halo.set({scale_x: 1, scale_y: 1, opacity: 150});
            this.halo.ease({
                scale_x: BEAT_GROWTH,
                scale_y: BEAT_GROWTH,
                opacity: 0,
                duration: BEAT,
                repeatCount: -1,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this.halo.set({scale_x: BEAT_GROWTH, scale_y: BEAT_GROWTH, opacity: 80});
        }
    }
});

export const PrivacyMarks = GObject.registerClass({
    Signals: {changed: {}},
}, class JoaoPrivacyMarks extends St.Widget {
    // @scene: its windows say which apps count. @side: 'END' or 'START', the corner of the badges.
    _init(manager, scene, settings) {
        super._init({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._manager = manager;
        this._scene = scene;
        this._settings = settings;
        this._monitor = privacyMonitor();
        this._key = '';
        this.uses = [];
        this.set_pivot_point(0.5, 0.5);

        this._frame = new St.Widget({style_class: 'joao-privacy-frame', x_expand: true, y_expand: true, visible: false});
        this.add_child(this._frame);
        this._badges = new St.BoxLayout({
            style_class: 'joao-privacy-badges',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            translation_x: OUT,
            translation_y: -OUT,
        });
        this.add_child(this._badges);

        this._menu = null;
        this._ids = [];
        if (this._monitor)
            this._ids.push([this._monitor, this._monitor.connect('changed', () => this.sync(true))]);
        for (const key of ['privacy-badges', 'privacy-pulse'])
            this._ids.push([settings, settings.connect(`changed::${key}`, () => this.sync(true))]);
        this.connect('destroy', () => this._onDestroy());
        this.sync(false);
    }

    _usesNow() {
        if (!this._monitor || !this._settings.get_boolean('privacy-badges'))
            return [];
        const apps = new Set(this._scene.windows.map(win => Shell.WindowTracker.get_default().get_window_app(win)?.get_id()));
        return [...apps].flatMap(id => (id ? this._monitor.usesOf(id) : []))
            .sort((a, b) => ['microphone', 'camera', 'screen'].indexOf(a[0]) - ['microphone', 'camera', 'screen'].indexOf(b[0]));
    }

    sync(animate) {
        const uses = this._usesNow();
        const key = `${uses.map(([device, entry]) => `${device}:${entry.appId}`).join()}|${this._settings.get_boolean('privacy-pulse')}`;
        if (key === this._key)
            return;
        const had = this.uses.length > 0;
        this._key = key;
        this.uses = uses;
        this._rebuild();
        const has = uses.length > 0;
        this.remove_all_transitions();
        if (animate && has !== had && this.has_allocation()) {
            if (has) {
                this.set({opacity: 0, scale_x: 0.6, scale_y: 0.6});
                this.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: APPEAR, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        } else {
            this.set({opacity: 255, scale_x: 1, scale_y: 1});
        }
        this.emit('changed');
    }

    // "usando el micrófono y la cámara", with the app in front: for the thumbnail's label.
    get doing() {
        if (!this.uses.length)
            return null;
        const devices = [...new Set(this.uses.map(([device]) => device))];
        const [first, ...rest] = devices.map(device => DEVICE_INFO[device].doing);
        const words = rest.length ? `${[first, ...rest.slice(0, -1)].join(', ')} y ${rest[rest.length - 1].replace(/^usando /, '')}` : first;
        return `${this.uses[0][1].name} — ${words}`;
    }

    _rebuild() {
        this._closeMenu();
        this._badges.destroy_all_children();
        const devices = [...new Set(this.uses.map(([device]) => device))];
        this._frame.visible = devices.length > 0;
        this._frame.set_style_class_name(`joao-privacy-frame ${devices[0] ?? ''}`);
        const pulse = this._settings.get_boolean('privacy-pulse');
        for (const device of devices) {
            const entries = this.uses.filter(([d]) => d === device).map(([, entry]) => entry);
            const badge = new HaloBadge(device, `${DEVICE_INFO[device].name}: ${entries.map(e => e.name).join(', ')}`, pulse);
            badge.connect('clicked', () => this._openMenu(badge, device, entries));
            this._badges.add_child(badge);
        }
    }

    _openMenu(badge, device, entries) {
        this._closeMenu();
        this._menu = new PopupMenu.PopupMenu(badge, 0.5, St.Side.TOP);
        this._menuManager = new PopupMenu.PopupMenuManager(badge, {actionMode: Shell.ActionMode.POPUP});
        this._menuManager.addMenu(this._menu);
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.addAction('Ir a la escena', () => goToApp(entries[0]));
        if (CUT_NAMES[device]) {
            for (const entry of entries.filter(e => canCut(device, e)))
                this._menu.addAction(cutLabel(device, entry), () => cut(device, entry));
        }
        this._menu.open();
    }

    _closeMenu() {
        this._menu?.destroy();
        this._menu = null;
        this._menuManager = null;
    }

    _onDestroy() {
        this._ids.forEach(([object, id]) => object.disconnect(id));
        this._ids = [];
        this._closeMenu();
    }
});
