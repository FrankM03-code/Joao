// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The tiles of the settings strip, 4 × 2: a rounded square with its name below, filled with the
// accent colour when on. Wi-Fi and Bluetooth carry a small arrow: they open their own view (the
// networks, the devices) instead of flipping. "Mic. silenciado" mutes the microphone; "Captura" opens
// GNOME's screenshot tool.
// Each one follows its setting both ways (backend/interruptores.js), so a change made in Settings
// shows here at once. Right click opens the matching page of Settings.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import {launchSettings} from '../sistema/common.js';
import {Signals, whenReady} from '../sistema/gnome.js';
import {makeBackends} from './backend/interruptores.js';
import {animations, makeIcon, sequence} from './iconosAnimados.js';

// id → [name, icon, page of Settings]
export const SWITCHES = {
    'wifi': ['Wi‑Fi', 'network-wireless-symbolic', 'wifi'],
    'bluetooth': ['Bluetooth', 'bluetooth-active-symbolic', 'bluetooth'],
    'dark': ['Oscuro', 'dark-mode-symbolic', 'background'],
    'dnd': ['No molestar', 'notifications-disabled-symbolic', 'notifications'],
    'night-light': ['Luz cálida', 'night-light-symbolic', 'display'],
    'airplane': ['Avión', 'airplane-mode-symbolic', 'wifi'],
    'mic': ['Mic. mudo', 'microphone-sensitivity-muted-symbolic', 'sound'],
    'captura': ['Captura', 'camera-photo-symbolic', null],
};
export const DEFAULT_ORDER = Object.keys(SWITCHES);
const OPENS = new Set(['wifi', 'bluetooth']);
const ACTIONS = new Set(['captura']);
const PLAIN = new Set(['mic', 'captura']);
const COLUMNS = 4;
const center = () => new Graphene.Point({x: 0.5, y: 0.5});

// A plain GNOME icon for the tiles that have no drawn one.
class PlainIcon {
    constructor(name) {
        this.actor = new St.Icon({icon_name: name, icon_size: 16});
    }

    setOn() {}
}

const Interruptor = GObject.registerClass({
    Signals: {'toggled': {param_types: [GObject.TYPE_BOOLEAN]}},
}, class JoaoAjustesInterruptor extends St.BoxLayout {
    _init(id) {
        const [name, iconName] = SWITCHES[id];
        super._init({style_class: 'joao-ajustes-interruptor', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.id = id;
        this.icon = PLAIN.has(id) ? new PlainIcon(iconName) : makeIcon(id);
        const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        // The ripple: a ring that grows and fades from the tile's edge.
        this._ripple = new St.Widget({style_class: 'joao-ajustes-onda', opacity: 0, pivot_point: center()});
        const inside = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        inside.add_child(new St.Bin({child: this.icon.actor, x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
        if (OPENS.has(id)) {
            inside.add_child(new St.Icon({style_class: 'joao-ajustes-mas', icon_name: 'go-next-symbolic', icon_size: 7,
                x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.END}));
        }
        this.button = new St.Button({
            style_class: 'joao-ajustes-circulo',
            can_focus: true,
            toggle_mode: false,
            x_align: Clutter.ActorAlign.CENTER,
            pivot_point: center(),
            accessible_name: name,
            child: inside,
            clip_to_allocation: true,
        });
        holder.add_child(this._ripple);
        holder.add_child(this.button);
        this.label = new St.Label({style_class: 'joao-ajustes-interruptor-nombre', text: name, x_align: Clutter.ActorAlign.CENTER});
        this.add_child(holder);
        this.add_child(this.label);
        this.on = false;
        this.available = true;
        this._synced = false;
        this.button.connect('clicked', () => this.press());
    }

    // The tile shrinks, overshoots and settles; a ring goes out from it.
    press() {
        if (!animations())
            return;
        const b = this.button;
        b.remove_all_transitions();
        b.set({scale_x: 1, scale_y: 1});
        sequence(b, [
            {scale_x: 0.88, scale_y: 0.88, duration: 110, mode: Clutter.AnimationMode.EASE_OUT_QUAD},
            {scale_x: 1.05, scale_y: 1.05, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD},
            {scale_x: 1, scale_y: 1, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_BACK},
        ]);
        const r = this._ripple;
        r.remove_all_transitions();
        r.set({scale_x: 1, scale_y: 1, opacity: 150});
        r.ease({scale_x: 1.35, scale_y: 1.35, opacity: 0, duration: 560, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    show_(on, available) {
        const changed = on !== this.on;
        this.on = on;
        this.available = available;
        this.button.checked = on;
        this.button.reactive = true;   // right click still opens Settings
        this.opacity = available ? 255 : 110;
        const state = available ? (on ? 'activado' : 'desactivado') : 'no disponible';
        this.button.accessible_name = OPENS.has(this.id)
            ? `${SWITCHES[this.id][0]}: ${state}, ver opciones` : `${SWITCHES[this.id][0]}: ${state}`;
        // The first sync only sets the state; later changes, from here or from outside, animate.
        if (changed || !this._synced)
            this.icon.setOn(on, this._synced);
        this._synced = true;
        if (changed)
            this.emit('toggled', on);
    }
});

export const Interruptores = GObject.registerClass({
    Signals: {
        'ready': {},
        'open': {param_types: [GObject.TYPE_STRING]},      // wifi or bluetooth: show its view
        'action': {param_types: [GObject.TYPE_STRING]},    // captura
    },
}, class JoaoAjustesInterruptores extends St.Widget {
    // @order: the six switches of Preferences to show; the microphone and Captura always come after.
    _init(order = DEFAULT_ORDER) {
        const layout = new Clutter.GridLayout({column_homogeneous: true, column_spacing: 4, row_spacing: 9});
        super._init({style_class: 'joao-ajustes-interruptores', layout_manager: layout, x_expand: true});
        this.switches = {};
        const ids = [...order.filter(id => SWITCHES[id] && !PLAIN.has(id)), 'mic', 'captura'];
        ids.forEach((id, i) => {
            const sw = new Interruptor(id);
            sw.button.connect('clicked', () => {
                if (OPENS.has(id))
                    this.emit('open', id);
                else if (ACTIONS.has(id))
                    this.emit('action', id);
                else
                    this.flip(id);
            });
            sw.button.connect('button-press-event', (a, event) => {
                if (event.get_button() !== Clutter.BUTTON_SECONDARY || !SWITCHES[id][2])
                    return Clutter.EVENT_PROPAGATE;
                launchSettings(SWITCHES[id][2]);
                return Clutter.EVENT_STOP;
            });
            layout.attach(sw, i % COLUMNS, Math.floor(i / COLUMNS), 1, 1);
            this.switches[id] = sw;
        });
        this.backends = null;
        this._signals = new Signals();
        this._cancelReady = whenReady(() => this._watch());
        this.connect('destroy', () => {
            this._cancelReady();
            this._signals.disconnectAll();
        });
    }

    _watch() {
        this.backends = makeBackends(this._signals);
        for (const [id, sw] of Object.entries(this.switches)) {
            const backend = this.backends[id];
            if (!backend) {
                sw.show_(false, true);
                continue;
            }
            const sync = () => sw.show_(backend.on, backend.available);
            backend.watch(sync);
            sync();
        }
        this.emit('ready');
    }

    flip(id) {
        const backend = this.backends?.[id];
        if (!backend?.available)
            return;
        backend.set(!backend.on);
    }
});
