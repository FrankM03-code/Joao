// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The volume of the strip: nothing on screen until the wheel is used over the strip or the launcher
// button. Then it comes out inside the "Nueva escena" box, with that box's own background, in place
// of its text, and goes away by itself. It is tied to GNOME's own slider, like the system panel's.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {gnome, Signals, whenReady} from '../sistema/gnome.js';
import {mirrorSlider, wheelSlider} from '../sistema/sliders.js';

const FADE_IN = 120;
const FADE_OUT = 200;
const HIDE_AFTER = 1500;

export const StripVolume = GObject.registerClass(
class StripVolume extends St.Bin {
    // @box: the "Nueva escena" button it comes out in.
    _init(box) {
        super._init({style_class: 'escenas-volume', reactive: true, track_hover: true, visible: false, opacity: 0,
            x_expand: true, y_expand: true});
        this._box = box;
        this._hideId = 0;
        this.icon = new St.Icon({icon_name: 'audio-volume-high-symbolic', style_class: 'escenas-volume-icon'});
        this.mute = new St.Button({style_class: 'escenas-volume-mute',
            y_align: Clutter.ActorAlign.CENTER, accessible_name: 'Silenciar', child: this.icon});
        this.slider = new Slider(0);
        this.slider.add_style_class_name('escenas-volume-slider');
        this.slider.x_expand = true;
        this.slider.y_align = Clutter.ActorAlign.CENTER;
        this.slider.accessible_name = 'Volumen';
        // GNOME says through this row whether there is a sound output.
        this._row = new St.BoxLayout({style_class: 'escenas-volume-row', x_expand: true, visible: false});
        this._row.add_child(this.mute);
        this._row.add_child(this.slider);
        this.set_child(this._row);

        this.connect('scroll-event', (a, event) => this.onWheel(event));
        // A click beside the line is not a click on "Nueva escena".
        for (const signal of ['button-press-event', 'button-release-event'])
            this.connect(signal, () => Clutter.EVENT_STOP);
        this.connect('destroy', () => this._onDestroy());
        box.addOverlay(this);
        this._signals = new Signals();
        this._cancelReady = whenReady(() => this._watch());
    }

    get dragging() {
        return !!this.slider._dragging;
    }

    onWheel(event) {
        if (!this._row.visible)
            return Clutter.EVENT_PROPAGATE;
        const result = wheelSlider(this.slider, event);
        if (result === Clutter.EVENT_STOP)
            this._reveal();
        return result;
    }

    _reveal() {
        this.remove_transition('opacity');
        this.show();
        this._box.setContentHidden(true);
        if (this.has_allocation())
            this.ease({opacity: 255, duration: FADE_IN, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else
            this.opacity = 255;
        this._hideLater();
    }

    _hideLater() {
        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_AFTER, () => {
            if (this.hover || this.dragging)
                return GLib.SOURCE_CONTINUE;
            this._hideId = 0;
            this._box.setContentHidden(false);
            this.ease({opacity: 0, duration: FADE_OUT, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: finished => finished && this.hide()});
            return GLib.SOURCE_REMOVE;
        });
    }

    hideNow() {
        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = 0;
        this.remove_transition('opacity');
        this.opacity = 0;
        this.hide();
        this._box.setContentHidden(false);
    }

    _watch() {
        const output = gnome.volumeSlider();
        mirrorSlider(this._signals, {row: this._row, icon: this.icon, slider: this.slider}, output);
        this._signals.connect(this.mute, 'clicked', () => output?.emit('icon-clicked'));
    }

    _onDestroy() {
        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = 0;
        this._cancelReady();
        this._signals.disconnectAll();
    }
});
