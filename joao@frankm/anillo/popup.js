// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The pieces the ring's menu and its tools are made of. A Layer covers the screen while one of
// them is open: it holds the keyboard (pushModal) and a click on it, outside the window, closes
// everything. A Popup is a page of the scenes card while it is the menu (curtain.js).
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {grabHoldsKeyboard} from '../sistema/compat.js';

export const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;
export const animations = () => St.Settings.get().enable_animations;

export const Layer = GObject.registerClass({
    Signals: {'outside': {}, 'escape': {}},
}, class JoaoRingLayer extends St.Widget {
    _init() {
        super._init({reactive: true, x: 0, y: 0, width: global.stage.width, height: global.stage.height});
        Main.uiGroup.add_child(this);
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        // Another grab (a menu, a dialog) is holding the keyboard: nothing opens.
        this.failed = !grabHoldsKeyboard(this._grab);
        // Only a press outside is taken: inside, the buttons must get it (since GNOME 49 they
        // recognize their clicks with gestures, which a stopped press cancels).
        this.connect('button-press-event', (actor, event) => {
            if (!this._outside(event))
                return Clutter.EVENT_PROPAGATE;
            this.emit('outside');
            return Clutter.EVENT_STOP;
        });
        this.connect('touch-event', (actor, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN || !this._outside(event))
                return Clutter.EVENT_PROPAGATE;
            this.emit('outside');
            return Clutter.EVENT_STOP;
        });
        this.connect('key-press-event', (actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this.emit('escape');
            return Clutter.EVENT_STOP;
        });
    }

    // On the layer itself, or on something above it but not in it (the ring).
    _outside(event) {
        const actor = global.stage.get_event_actor(event);
        return actor === this || !this.contains(actor);
    }

    // The keyboard and the clicks go back at once; the window may still be shrinking.
    release() {
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this.reactive = false;
    }

    destroy() {
        this.release();
        super.destroy();
    }
});

// What the scenes card shows while it is the ring's menu: the menu itself or a tool
// (curtain.js places it and moves the curtain).
export const Popup = GObject.registerClass(
class JoaoRingPage extends St.BoxLayout {
    _init(params = {}) {
        super._init({orientation: Clutter.Orientation.VERTICAL, reactive: true, x_expand: true, ...params});
    }

    // Esc on this page. The tools go back to the menu; the menu closes.
    escape() {
        this.back?.();
    }
});

// The top of a tool's window: back to the menu, its name and, maybe, something on the right.
export function header(title, back, extra = null) {
    const box = new St.BoxLayout({style_class: 'joao-ring-head', x_expand: true});
    const button = new St.Button({style_class: 'joao-ring-back', can_focus: true, accessible_name: 'Volver al menú',
        y_align: Clutter.ActorAlign.CENTER, child: new St.Icon({icon_name: 'go-previous-symbolic'})});
    button.connect('clicked', back);
    box.add_child(button);
    box.add_child(new St.Label({style_class: 'joao-ring-title', text: title, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
    if (extra)
        box.add_child(extra);
    return box;
}

// A small menu of choices next to something (a row, the note's pill), in the same layer.
export const ChoiceMenu = GObject.registerClass(
class JoaoRingChoices extends St.BoxLayout {
    // choices: [[label, run], …]
    _init(choices, onDone) {
        super._init({style_class: 'joao-ring-choices', orientation: Clutter.Orientation.VERTICAL, reactive: true});
        for (const [label, run] of choices) {
            const button = new St.Button({style_class: 'joao-ring-choice', label, can_focus: true, x_expand: true});
            button.connect('clicked', () => {
                this.destroy();
                onDone?.();
                run();
            });
            this.add_child(button);
        }
    }

    showAt(layer, x, y) {
        layer.add_child(this);
        const [, width] = this.get_preferred_width(-1);
        const [, height] = this.get_preferred_height(width);
        this.set_position(Math.round(Math.min(x, global.stage.width - width - 8)), Math.round(Math.min(y, global.stage.height - height - 8)));
        this.get_first_child()?.grab_key_focus();
    }
});
