// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The timer's window: a dial with the time, four lengths, a label and "Iniciar". While it runs
// the same window pauses, resumes or stops it.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {animations, header, Popup, scaleFactor} from './popup.js';
import {clock} from './timer.js';

const PRESETS = [[5, '5 min'], [15, '15'], [25, '25'], [60, '60']];
const DIAL = 120;
const STROKE = 8;
const SETTLE = 500;
// The accent: lilac is only for the ring and the alarm (docs/menu-cortina-spec.md).
const ACCENT = [0x8f / 255, 0xb8 / 255, 0xff / 255];

// The dial: a blue ring as long as what is left, and the time in the middle.
const Dial = GObject.registerClass(
class JoaoTimerDial extends St.Widget {
    _init() {
        super._init({style_class: 'joao-timer-dial', layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        const size = DIAL * scaleFactor();
        this._area = new St.DrawingArea({width: size, height: size});
        this._area.connect('repaint', () => this._paint());
        this.add_child(this._area);
        this.label = new St.Label({style_class: 'joao-timer-big', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this.label);
        this._fraction = 1;
        this._timeline = null;
        this.connect('destroy', () => this._timeline?.stop());
    }

    set fraction(f) {
        this._timeline?.stop();
        this._timeline = null;
        this._fraction = f;
        this._area.queue_repaint();
    }

    // A new length: the ring comes back round from part of the way (EASE_OUT_QUINT).
    settle(from) {
        this._timeline?.stop();
        if (!animations()) {
            this.fraction = 1;
            return;
        }
        const timeline = new Clutter.Timeline({actor: this, duration: SETTLE});
        timeline.connect('new-frame', () => {
            const t = timeline.get_progress();
            const eased = 1 - (1 - t) ** 5;
            this._fraction = from + (1 - from) * eased;
            this._area.queue_repaint();
        });
        timeline.connect('completed', () => {
            this._timeline = null;
            this._fraction = 1;
            this._area.queue_repaint();
        });
        this._timeline = timeline;
        timeline.start();
    }

    _paint() {
        const cr = this._area.get_context();
        const [w, h] = this._area.get_surface_size();
        const scale = scaleFactor();
        const r = (DIAL / 2 - STROKE / 2 - 1) * scale;
        cr.translate(w / 2, h / 2);
        cr.setLineWidth(STROKE * scale);
        cr.setLineCap(1);   // round
        cr.setSourceRGBA(1, 1, 1, 0.12);
        cr.arc(0, 0, r, 0, 2 * Math.PI);
        cr.stroke();
        if (this._fraction > 0.001) {
            cr.setSourceRGBA(...ACCENT, 1);
            cr.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.min(this._fraction, 0.9999));
            cr.stroke();
        }
        cr.$dispose();
    }
});

export const TimerWindow = GObject.registerClass(
class JoaoTimerWindow extends Popup {
    // started(): it was started, the window may go.
    // label: the one to start with ("Recordarme" from a note), or the last one used.
    _init({timer, back, started, label = null}) {
        super._init({style_class: 'joao-ring-tool joao-timer-window'});
        this._timer = timer;
        this._started = started;
        this.back = back;
        this._minutes = timer.duration ? Math.round(timer.duration / 60) : 25;
        if (!PRESETS.some(([m]) => m === this._minutes))
            this._minutes = 25;
        this.add_child(header('Temporizador', back));

        this.dial = new Dial();
        this.add_child(this.dial);

        this._choose = new St.BoxLayout({style_class: 'joao-timer-chips', x_align: Clutter.ActorAlign.CENTER});
        this.chips = PRESETS.map(([m, text]) => {
            const chip = new St.Button({style_class: 'joao-timer-chip', label: text, can_focus: true,
                accessible_name: `${m} minutos`});
            chip.minutes = m;
            chip.connect('clicked', () => this.choose(m));
            this._choose.add_child(chip);
            return chip;
        });
        this.add_child(this._choose);
        this.entry = new St.Entry({style_class: 'joao-timer-label', hint_text: 'Etiqueta · ej. Horno', can_focus: true, x_expand: true,
            text: label ?? timer.label});
        this.entry.clutter_text.connect('activate', () => this.startButton.emit('clicked', 1));
        this.add_child(this.entry);

        this.startButton = new St.Button({style_class: 'joao-timer-start', label: 'Iniciar', can_focus: true, x_expand: true});
        this.startButton.connect('clicked', () => {
            this._timer.start(this._minutes * 60, this.entry.text);
            this._started();
        });
        this.add_child(this.startButton);

        this._running = new St.BoxLayout({style_class: 'joao-timer-running', x_expand: true});
        this.pauseButton = new St.Button({style_class: 'joao-timer-start', label: 'Pausar', can_focus: true, x_expand: true});
        this.pauseButton.connect('clicked', () => (this._timer.paused ? this._timer.resume() : this._timer.pause()));
        this.stopButton = new St.Button({style_class: 'joao-timer-stop', label: 'Detener', can_focus: true, x_expand: true});
        this.stopButton.connect('clicked', () => this._timer.stop());
        this._running.add_child(this.pauseButton);
        this._running.add_child(this.stopButton);
        this.add_child(this._running);

        timer.connectObject('tick', () => this._sync(), 'changed', () => this._sync(), this);
        this.connect('destroy', () => timer.disconnectObject(this));
        this._sync();
    }

    focus() {
        (this._timer.active ? this.pauseButton : this.startButton).grab_key_focus();
    }

    choose(minutes) {
        const before = this._minutes;
        this._minutes = minutes;
        this._sync();
        if (before !== minutes)
            this.dial.settle(Math.min(before, minutes) / Math.max(before, minutes));
    }

    _sync() {
        const t = this._timer;
        const active = t.active;
        this._choose.visible = !active;
        this.entry.visible = !active;
        this.startButton.visible = !active;
        this._running.visible = active;
        this.chips.forEach(chip => {
            if (chip.minutes === this._minutes)
                chip.add_style_pseudo_class('checked');
            else
                chip.remove_style_pseudo_class('checked');
        });
        if (active) {
            this.dial.label.text = clock(t.remaining);
            this.dial.fraction = t.fraction;
            this.pauseButton.label = t.paused ? 'Seguir' : 'Pausar';
        } else {
            this.dial.label.text = clock(this._minutes * 60);
            if (!this.dial._timeline)
                this.dial.fraction = 1;
        }
        // The keyboard must not be left on something that went away.
        const focus = global.stage.key_focus;
        if (focus && this.contains(focus) && !focus.is_mapped())
            this.focus();
    }
});
