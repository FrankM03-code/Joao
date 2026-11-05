// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Ahorro / Equilibrado / Rendimiento, through the proxy GNOME's own menu uses.
// Without power-profiles-daemon the block is not shown.
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gnome, Signals, whenReady} from './gnome.js';

const PROFILES = [
    {id: 'power-saver', name: 'Ahorro'},
    {id: 'balanced', name: 'Equilibrado'},
    {id: 'performance', name: 'Rendimiento'},
];

export const PowerProfile = GObject.registerClass(
class JoaoPowerProfile extends St.BoxLayout {
    _init(tooltip) {
        super._init({style_class: 'escenas-full-profiles', x_expand: true, visible: false});
        this.buttons = {};
        for (const profile of PROFILES) {
            const button = new St.Button({
                style_class: 'escenas-full-profile',
                can_focus: true,
                x_expand: true,
                label: profile.name,
                accessible_name: `Modo de energía: ${profile.name}`,
            });
            button.connect('clicked', () => {
                if (this._proxy)
                    this._proxy.ActiveProfile = profile.id;
            });
            tooltip.attach(button, `Modo de energía: ${profile.name}`);
            this.add_child(button);
            this.buttons[profile.id] = button;
        }
        this._signals = new Signals();
        this._cancelReady = whenReady(() => {
            this._proxy = gnome.powerProfiles();
            this._signals.connect(this._proxy, 'g-properties-changed', () => this.sync());
            this.sync();
        });
        this.connect('destroy', () => this._onDestroy());
    }

    sync() {
        const proxy = this._proxy;
        const available = (proxy?.Profiles ?? []).map(p => p.Profile?.unpack?.() ?? p.Profile);
        this.visible = available.length > 0;
        for (const {id} of PROFILES) {
            this.buttons[id].visible = available.includes(id);
            this.buttons[id].checked = proxy?.ActiveProfile === id;
        }
    }

    _onDestroy() {
        this._cancelReady();
        this._signals.disconnectAll();
    }
});
