// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Volume and brightness in the settings strip: GNOME's slider (ui/slider.js) drawn as a thick
// white bar, with the value at its right. Each one is tied both ways to GNOME's own slider
// (sistema/sliders.js), so the keyboard's volume keys move it too, and GNOME applies the change.
// No backlight: no brightness row. The speaker mutes on click, as in GNOME's menu.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {gnome, Signals, whenReady} from '../sistema/gnome.js';
import {mirrorSlider, wheelSlider} from '../sistema/sliders.js';
import {SpeakerIcon, SunIcon, animations, run} from './iconosAnimados.js';

const HANDLE = 8;          // px: the round handle's radius (stylesheet)
const HANDLE_GROWN = 1.25;  // while dragging
const HANDLE_TIME = 300;

export const Controles = GObject.registerClass(
class JoaoAjustesControles extends St.BoxLayout {
    _init() {
        super._init({style_class: 'joao-ajustes-controles', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._speaker = new SpeakerIcon();
        this._sun = new SunIcon();
        this.volume = this._row(this._speaker.actor, 'Volumen');
        this.brightness = this._row(this._sun.actor, 'Brillo');
        // GNOME's icon names come here (the binding in mirrorSlider): they say when it is muted.
        this.volume.gnomeIcon = new St.Icon();
        this.volume.slider.connect('notify::value', () => this._syncSpeaker());
        this.volume.gnomeIcon.connect('notify::icon-name', () => this._syncSpeaker());
        this.brightness.slider.connect('notify::value', () => this._sun.set(this.brightness.slider.value));
        this._sun.set(this.brightness.slider.value);
        this._signals = new Signals();
        this._cancelReady = whenReady(() => this._watch());
        this.connect('destroy', () => {
            this._cancelReady();
            this._signals.disconnectAll();
        });
    }

    _row(icon, name) {
        const row = new St.BoxLayout({style_class: 'joao-ajustes-control', x_expand: true});
        const iconButton = new St.Button({style_class: 'joao-ajustes-control-icono', can_focus: false,
            y_align: Clutter.ActorAlign.CENTER, accessible_name: name, child: icon});
        const slider = new Slider(0);
        slider.add_style_class_name('joao-ajustes-barra');
        slider.set({x_expand: true, y_align: Clutter.ActorAlign.CENTER, accessible_name: name});
        slider.connect('scroll-event', (a, event) => wheelSlider(slider, event));
        const value = new St.Label({style_class: 'joao-ajustes-control-valor', y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END});
        const sync = () => {
            value.text = `${Math.round(slider.value * 100)}`;
        };
        slider.connect('notify::value', sync);
        sync();
        slider.connect('drag-begin', () => this._grow(slider, HANDLE_GROWN));
        slider.connect('drag-end', () => this._grow(slider, 1));
        row.add_child(iconButton);
        row.add_child(slider);
        row.add_child(value);
        this.add_child(row);
        return {row, icon, iconButton, slider, value};
    }

    _watch() {
        const output = gnome.volumeSlider();
        mirrorSlider(this._signals, {...this.volume, icon: this.volume.gnomeIcon}, output);
        this._signals.connect(this.volume.iconButton, 'clicked', () => output?.emit('icon-clicked'));
        // Our sun is drawn: GNOME's icon name goes to a spare icon nobody shows.
        mirrorSlider(this._signals, {...this.brightness, icon: new St.Icon()}, gnome.brightnessSlider());
        // Nothing to show (no sound card and no backlight): the block goes too.
        const syncBlock = () => {
            this.visible = this.volume.row.visible || this.brightness.row.visible;
        };
        this._signals.connect(this.volume.row, 'notify::visible', syncBlock);
        this._signals.connect(this.brightness.row, 'notify::visible', syncBlock);
        syncBlock();
        this._syncSpeaker();
    }

    _syncSpeaker() {
        const muted = (this.volume.gnomeIcon.icon_name ?? '').includes('muted');
        this._speaker.set(this.volume.slider.value, muted);
    }

    // The round handle grows while dragged, with a spring, and goes back on release.
    _grow(slider, to) {
        slider._stopGrow?.();
        const from = slider._handleScale ?? 1;
        const set = scale => {
            slider._handleScale = scale;
            slider.set_style(`-slider-handle-radius: ${(HANDLE * scale).toFixed(2)}px;`);
        };
        if (!animations()) {
            set(to);
            return;
        }
        // EASE_OUT_BACK by hand: the timeline gives the time, this gives the overshoot.
        const back = t => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
        slider._stopGrow = run(slider, HANDLE_TIME, ms => set(from + (to - from) * back(Math.min(1, ms / HANDLE_TIME))));
    }
});
