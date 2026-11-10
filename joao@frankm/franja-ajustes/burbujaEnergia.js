// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The round power button mounted on the settings strip's bottom edge. A chrome actor of its own
// (it sticks out of the strip, and stays at the screen edge while the strip is hidden). Its outer
// ring takes the colour of the active mode (phase 6).
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

export const BUBBLE_SIZE = 46;
export const RING = 0;
export const HOLDER_SIZE = BUBBLE_SIZE + 2 * RING + 4;
export const DEFAULT_RING = 'rgba(28,95,189,0.9)';
const RING_TIME = 300;

const center = () => new Graphene.Point({x: 0.5, y: 0.5});

export class BurbujaEnergia {
    constructor(onClick) {
        // The holder belongs to the layout manager (it hides it in fullscreen); this.bubble is ours.
        this.holder = new St.Widget({
            name: 'joaoAjustesBurbuja',
            layout_manager: new Clutter.BinLayout(),
            width: HOLDER_SIZE,
            height: HOLDER_SIZE,
        });
        this.bubble = new St.Widget({layout_manager: new Clutter.BinLayout(), pivot_point: center(),
            x_expand: true, y_expand: true});
        // Two rings: the new colour fades in over the old one (St cannot ease a colour).
        this._rings = [0, 1].map(() => new St.Widget({style_class: 'joao-ajustes-burbuja-aro',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
        this._front = 0;
        this.button = new St.Button({
            style_class: 'joao-ajustes-burbuja',
            can_focus: true,
            reactive: true,
            accessible_name: 'Energía',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            pivot_point: center(),
            child: new St.Icon({icon_name: 'system-shutdown-symbolic', icon_size: 17, pivot_point: center()}),
        });
        this.button.connect('clicked', () => onClick());
        this._rings.forEach(ring => this.bubble.add_child(ring));
        this.bubble.add_child(this.button);
        this.holder.add_child(this.bubble);
        // No mode colour: the ring takes the panel's colour from the stylesheet.
        this._color = null;
    }

    get icon() {
        return this.button.child;
    }

    // The active mode's colour (null: the panel's colour), in 300 ms.
    setRingColor(color) {
        color ||= null;
        if (color === this._color)
            return;
        this._color = color;
        const back = this._rings[this._front];
        this._front = 1 - this._front;
        const front = this._rings[this._front];
        front.set_style(color ? `background-color: ${color};` : null);
        front.remove_all_transitions();
        this.bubble.set_child_above_sibling(front, back);
        front.opacity = 0;
        front.ease({opacity: 255, duration: RING_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    destroy() {
        this.holder.destroy();
    }
}
