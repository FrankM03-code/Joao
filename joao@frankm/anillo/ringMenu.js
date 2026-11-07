// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The ring's menu, inside the scenes card (curtain.js): "Herramientas", quick note, clipboard and
// timer, and how to go back. White icons in circles, like the ring; each shortcut is in the row's
// tooltip (the card is narrow). The arrows move between them and Enter picks one.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Tooltip} from '../sistema/common.js';
import {animations, Popup, scaleFactor} from './popup.js';

const MODS = {super: 'Super', alt: 'Alt', control: 'Ctrl', primary: 'Ctrl', ctrl: 'Ctrl', shift: 'Mayús'};
const HEAD_DROP = 10;
const HEAD_TIME = 400;
const HEAD_DELAY = 120;
const ROW_DROP = 14;
const ROW_TIME = 450;
const ROW_DELAYS = [180, 260, 340];
const LEAVE = 150;

// '<Super><Alt>n' → 'Super+Alt+N'.
export function prettyAccel(accel) {
    if (!accel)
        return '';
    const mods = (accel.match(/<([^>]+)>/g) ?? []).map(m => MODS[m.slice(1, -1).toLowerCase()] ?? m.slice(1, -1));
    const key = accel.replace(/<[^>]+>/g, '');
    return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+');
}

export const TOOLS = [
    {id: 'note', title: 'Nota rápida', sub: 'Se fija en el panel', icon: 'document-edit-symbolic', key: 'ring-note-shortcut'},
    {id: 'clipboard', title: 'Portapapeles', sub: '25 copias recientes', icon: 'edit-paste-symbolic', key: 'ring-clipboard-shortcut'},
    {id: 'timer', title: 'Temporizador', sub: 'En el anillo', icon: 'alarm-symbolic', key: 'ring-timer-shortcut'},
];

export const RingMenu = GObject.registerClass(
class JoaoRingMenu extends Popup {
    // pick(id): the tool chosen. timer: its summary while it runs.
    _init({settings, timer, pick}) {
        super._init({style_class: 'joao-ring-menu'});
        this._timer = timer;
        this._tooltip = new Tooltip();

        this._head = new St.BoxLayout({style_class: 'joao-ring-menu-head', x_expand: true});
        this._head.add_child(new St.Label({text: 'Herramientas', x_expand: true}));
        this._head.add_child(new St.Label({text: 'Esc'}));
        this.add_child(this._head);

        this.rows = TOOLS.map(tool => {
            const accel = prettyAccel(settings.get_strv(tool.key)[0]);
            const row = new St.Button({style_class: 'joao-ring-row', can_focus: true, x_expand: true,
                accessible_name: accel ? `${tool.title} (${accel})` : tool.title});
            const box = new St.BoxLayout({style_class: 'joao-ring-row-box', x_expand: true});
            box.add_child(new St.Bin({style_class: 'joao-ring-icon', y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({icon_name: tool.icon})}));
            const words = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            words.add_child(new St.Label({style_class: 'joao-ring-row-title', text: tool.title}));
            row.sub = new St.Label({style_class: 'joao-ring-row-sub', text: tool.sub});
            words.add_child(row.sub);
            box.add_child(words);
            row.set_child(box);
            row.tool = tool;
            row.connect('clicked', () => pick(tool.id));
            if (accel)
                this._tooltip.attach(row, `Atajo: ${accel}`);
            this.add_child(row);
            return row;
        });
        this._foot = new St.Label({style_class: 'joao-ring-menu-foot', text: 'Clic en el anillo para volver a escenas',
            x_align: Clutter.ActorAlign.CENTER});
        this._foot.clutter_text.line_wrap = true;
        this.add_child(this._foot);

        this._timerRow = this.rows.find(r => r.tool.id === 'timer');
        timer.connectObject('tick', () => this._syncTimer(), 'changed', () => this._syncTimer(), this);
        this._syncTimer();
        this.connect('destroy', () => {
            timer.disconnectObject(this);
            this._tooltip.destroy();
        });
        this.connect('key-press-event', (actor, event) => this._onKey(event));
    }

    _syncTimer() {
        this._timerRow.sub.text = this._timer.active
            ? `${this._timer.summary}${this._timer.paused ? ' · en pausa' : ''}`
            : this._timerRow.tool.sub;
    }

    // The curtain is coming down: the heading, then the rows one after another.
    enter(animate) {
        this.rows[0].grab_key_focus();
        if (!animate || !animations())
            return;
        const scale = scaleFactor();
        this._head.set({opacity: 0, translation_y: -HEAD_DROP * scale});
        this._head.ease({opacity: 255, translation_y: 0, delay: HEAD_DELAY, duration: HEAD_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT});
        this.rows.forEach((row, i) => {
            row.set({opacity: 0, translation_y: -ROW_DROP * scale});
            // No bounce (Frank 2026-11-07): they settle.
            row.ease({opacity: 255, translation_y: 0, delay: ROW_DELAYS[i], duration: ROW_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT});
        });
        this._foot.set({opacity: 0});
        this._foot.ease({opacity: 255, delay: 400, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // Going: everything fades at once, quickly.
    leave() {
        this._tooltip.hide();
        for (const actor of [this._head, ...this.rows, this._foot]) {
            actor.remove_all_transitions();
            actor.ease({opacity: 0, duration: LEAVE, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    focusFirst() {
        this.rows[0].grab_key_focus();
    }

    _onKey(event) {
        const step = {[Clutter.KEY_Up]: -1, [Clutter.KEY_Down]: 1}[event.get_key_symbol()];
        if (!step)
            return Clutter.EVENT_PROPAGATE;
        const now = this.rows.findIndex(r => r.has_key_focus());
        const next = now < 0 ? 0 : (now + step + this.rows.length) % this.rows.length;
        this.rows[next].grab_key_focus();
        return Clutter.EVENT_STOP;
    }
});
