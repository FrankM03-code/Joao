// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The card that comes out of the launcher button when the timer ends: it grows from the button
// to its place and shrinks back into it when it goes. It carries the notification's buttons
// (+5 min, Repetir) and Cerrar. The notification itself goes through João's usual way too (the
// bubble, the panel's list), so it is not lost if this card is closed.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {animations, scaleFactor} from './popup.js';

const BORN = 550;
const BACK = 350;
const FROM_SCALE = 0.15;
const FROM_SHIFT = 70;

export const AlarmCard = GObject.registerClass(
class JoaoAlarmCard extends St.BoxLayout {
    // actions: [[label, run, primary], …]; each closes the card first.
    _init({body, sub, actions}) {
        super._init({style_class: 'joao-ring-popup joao-alarm-card', reactive: true, opacity: 0});
        this.add_child(new St.Bin({style_class: 'joao-ring-icon timer', y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'alarm-symbolic'})}));
        const words = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const head = new St.BoxLayout({x_expand: true});
        head.add_child(new St.Label({style_class: 'joao-alarm-app', text: 'Temporizador', x_expand: true}));
        head.add_child(new St.Label({style_class: 'joao-alarm-when', text: 'ahora'}));
        words.add_child(head);
        const bodyLabel = new St.Label({style_class: 'joao-alarm-body', text: body});
        bodyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        words.add_child(bodyLabel);
        words.add_child(new St.Label({style_class: 'joao-alarm-sub', text: sub}));
        const row = new St.BoxLayout({style_class: 'joao-alarm-actions'});
        this.buttons = actions.map(([label, run, primary]) => {
            const button = new St.Button({style_class: `joao-alarm-action${primary ? ' primary' : ''}`, label, can_focus: true});
            button.connect('clicked', () => this.close(run));
            row.add_child(button);
            return button;
        });
        words.add_child(row);
        this.add_child(words);
        this.accessible_name = `Temporizador: ${body}. ${sub}`;
        Main.layoutManager.addTopChrome(this);
    }

    // anchor: {x, bottom, side, monitor} beside the button.
    show(anchor) {
        const [, width] = this.get_preferred_width(-1);
        const [, height] = this.get_preferred_height(width);
        const m = anchor.monitor;
        const margin = 8 * scaleFactor();
        const x = anchor.side > 0 ? anchor.x : anchor.x - width;
        this.set_position(Math.round(Math.max(m.x + margin, Math.min(x, m.x + m.width - width - margin))),
            Math.round(Math.max(m.y + margin, Math.min(anchor.bottom - height, m.y + m.height - height - margin))));
        this._side = anchor.side;
        Main.layoutManager.uiGroup.set_child_above_sibling(this, null);
        this.set_pivot_point(anchor.side > 0 ? 0 : 1, 0.5);
        if (!animations()) {
            this.opacity = 255;
            return;
        }
        this.set({opacity: 0, scale_x: FROM_SCALE, scale_y: FROM_SCALE, translation_x: -anchor.side * FROM_SHIFT * scaleFactor()});
        this.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this.ease({scale_x: 1, scale_y: 1, translation_x: 0, duration: BORN, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    // Back into the button; then run (an action), if any.
    close(run = null) {
        if (this._closing)
            return;
        this._closing = true;
        this.reactive = false;
        const finish = () => {
            Main.layoutManager.removeChrome(this);
            this.destroy();
        };
        run?.();
        this.remove_all_transitions();
        if (!animations() || !this.is_mapped()) {
            finish();
            return;
        }
        this.ease({opacity: 0, scale_x: FROM_SCALE, scale_y: FROM_SCALE, translation_x: -this._side * FROM_SHIFT * scaleFactor(),
            duration: BACK, mode: Clutter.AnimationMode.EASE_IN_QUAD, onStopped: finish});
    }
});
