// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The card beside the launcher button while something uses the screen, the microphone or the
// camera: "En uso ahora" and a row per app and device, in the ring's order, with its colour bar,
// the app, how long it has been going and a stop button. Clicking the row goes to the app.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SHIFT = 10;
const FADE_IN = 250;
const GROW_IN = 400;
const CONCEAL = 180;
const COLLAPSE = 400;
const STOP_HOVER = 220;
const MODE = Clutter.AnimationMode.EASE_OUT_QUINT;

const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

// mm:ss, or h:mm:ss from an hour on.
export function elapsed(since, now = GLib.get_real_time() / 1e6) {
    const total = Math.max(0, Math.floor(now - since));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}

const StopButton = GObject.registerClass(
class JoaoStopButton extends St.Button {
    _init(device) {
        super._init({style_class: `joao-stop ${device}`, can_focus: true, track_hover: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._square = new St.Widget({style_class: 'joao-stop-square', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'joao-stop-icon', icon_name: 'audio-input-microphone-symbolic', visible: false});
        const box = new St.Widget({layout_manager: new Clutter.BinLayout()});
        box.add_child(this._square);
        box.add_child(this._icon);
        this.set_child(box);
        this.connect('notify::hover', () => this._grow());
        this.connect('key-focus-in', () => this._grow());
        this.connect('key-focus-out', () => this._grow());
    }

    // reactivate: the microphone is muted and the button gives it back.
    setReactivate(on) {
        this._square.visible = !on;
        this._icon.visible = on;
    }

    _grow() {
        const up = this.hover || this.has_key_focus();
        this.set_pivot_point(0.5, 0.5);
        this.ease({scale_x: up ? 1.08 : 1, scale_y: up ? 1.08 : 1, duration: STOP_HOVER, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
});

const Row = GObject.registerClass(
class JoaoUseRow extends St.Button {
    _init(device) {
        super._init({style_class: 'joao-use-row', can_focus: true, x_expand: true, clip_to_allocation: true});
        this.device = device;
        const box = new St.BoxLayout({style_class: 'joao-use-row-box', x_expand: true});
        box.add_child(new St.Widget({style_class: `joao-use-bar ${device}`, y_align: Clutter.ActorAlign.CENTER}));
        this._iconBin = new St.Bin({style_class: 'joao-use-app', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._iconBin);
        const words = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = new St.Label({style_class: 'joao-use-title'});
        this._sub = new St.Label({style_class: 'joao-use-sub'});
        for (const label of [this._title, this._sub])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        words.add_child(this._title);
        words.add_child(this._sub);
        box.add_child(words);
        this._stop = new StopButton(device);
        this._stop.connect('clicked', () => this._use?.onStop?.());
        box.add_child(this._stop);
        this.set_child(box);
        this.connect('clicked', () => this._use?.onGo?.());
    }

    fill(use) {
        this._use = use;
        this._title.text = use.title;
        if (use.gicon !== this._gicon || !this._iconBin.child) {
            this._gicon = use.gicon;
            this._iconBin.child = new St.Icon({gicon: use.gicon, icon_size: use.appIcon ? 24 : 14,
                style_class: use.appIcon ? '' : 'joao-use-app-symbolic'});
            this._iconBin.set_style_class_name(use.appIcon ? 'joao-use-app' : 'joao-use-app plain');
        }
        this._stop.visible = !!use.onStop;
        this._stop.setReactivate(!!use.muted);
        this._stop.accessible_name = use.stopLabel ?? '';
        this.accessible_name = use.description;
        this.tick();
    }

    tick() {
        if (!this._use)
            return;
        this._sub.text = this._use.muted
            ? `${this._use.app} · silenciado`
            : `${this._use.app} · ${elapsed(this._use.since)}`;
    }

    // Folds away (height and opacity to nothing), then is gone.
    collapse(done) {
        this.reactive = false;
        this.collapsing = true;
        const [, height] = this.get_preferred_height(-1);
        this.height = height;
        this.ease({height: 0, opacity: 0, duration: COLLAPSE, mode: MODE, onComplete: done});
    }
});

export const CompactTray = GObject.registerClass(
class JoaoCompactTray extends St.BoxLayout {
    _init() {
        super._init({style_class: 'joao-use-card', vertical: true, reactive: true, track_hover: true,
            visible: false, opacity: 0});
        this.add_child(new St.Label({style_class: 'joao-use-heading', text: 'En uso ahora'}));
        this._rows = new Map();
        this._side = 1;
        this._closing = false;
        this._tickId = 0;
        Main.layoutManager.addTopChrome(this);
    }

    get isShowing() {
        return this.visible && !this._closing;
    }

    // The rows still in use (the notifications list goes above them).
    get chips() {
        return [...this._rows.values()].filter(row => !row.collapsing);
    }

    // uses = [{key, device, title, app, gicon, appIcon, since, muted, stopLabel, description, onStop, onGo}]
    update(uses) {
        const keys = new Set(uses.map(use => use.key));
        for (const [key, row] of this._rows) {
            if (keys.has(key) || row.collapsing)
                continue;
            if (this.visible && !this._closing) {
                row.collapse(() => {
                    if (this._rows.get(key) === row)
                        this._rows.delete(key);
                    row.destroy();
                });
            } else {
                this._rows.delete(key);
                row.destroy();
            }
        }
        uses.forEach((use, index) => {
            let row = this._rows.get(use.key);
            if (row?.collapsing) {
                row.destroy();
                row = null;
            }
            if (!row) {
                row = new Row(use.device);
                this._rows.set(use.key, row);
                this.add_child(row);
            }
            row.fill(use);
            this.set_child_at_index(row, index + 1);
        });
        this._syncTick();
    }

    _syncTick() {
        const want = this.visible && this._rows.size > 0;
        if (want && !this._tickId) {
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._rows.forEach(row => row.tick());
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!want && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    // side: 1 when it opens towards the right of what it belongs to, -1 towards the left.
    // It grows from the corner next to the button, at the bottom.
    reveal(side) {
        this._side = side;
        this._closing = false;
        this.remove_all_transitions();
        this.set_pivot_point(side > 0 ? 0 : 1, 1);
        if (!this.visible) {
            this.set({opacity: 0, scale_x: 0.96, scale_y: 0.96, translation_x: -side * SHIFT * scaleFactor(), visible: true});
            this._rows.forEach(row => row.tick());
        }
        this.ease({opacity: 255, duration: FADE_IN, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this.ease({scale_x: 1, scale_y: 1, translation_x: 0, duration: GROW_IN, mode: MODE});
        this._syncTick();
    }

    conceal(animate) {
        if (!this.visible)
            return;
        this.remove_all_transitions();
        if (!animate) {
            this._finishConceal();
            return;
        }
        this._closing = true;
        this.ease({opacity: 0, scale_x: 0.96, scale_y: 0.96, duration: CONCEAL, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: finished => {
                if (finished)
                    this._finishConceal();
            }});
    }

    _finishConceal() {
        this._closing = false;
        this.hide();
        this.update([]);
    }

    destroy() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        Main.layoutManager.removeChrome(this);
        super.destroy();
    }
});
