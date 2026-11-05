// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Volume and brightness. Each slider is tied to GNOME's own one in both directions, so its
// change is the very change GNOME's menu would make. No backlight, no brightness row.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {gnome, Signals, whenReady} from './gnome.js';

const WHEEL_STEP = 0.05;

// The wheel over a slider moves it.
export function wheelSlider(slider, event) {
    if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
        return Clutter.EVENT_PROPAGATE;
    let delta = 0;
    const direction = event.get_scroll_direction();
    if (direction === Clutter.ScrollDirection.UP)
        delta = WHEEL_STEP;
    else if (direction === Clutter.ScrollDirection.DOWN)
        delta = -WHEEL_STEP;
    else if (direction === Clutter.ScrollDirection.SMOOTH)
        delta = -event.get_scroll_delta()[1] * WHEEL_STEP;
    slider.value = Math.max(0, Math.min(slider.value + delta, slider.maximum_value));
    return Clutter.EVENT_STOP;
}

// Two-way link between our {row, icon, slider} and GNOME's (its own handler applies the change).
export function mirrorSlider(signals, ours, theirs) {
    if (!theirs) {
        ours.row.visible = false;
        return;
    }
    const s = signals;
    const flags = GObject.BindingFlags.SYNC_CREATE;
    s.bind(theirs, 'visible', ours.row, 'visible', flags);
    s.bind(theirs, 'icon-name', ours.icon, 'icon-name', flags);
    s.bind(theirs.slider, 'maximum-value', ours.slider, 'maximum-value', flags);
    s.bind(theirs.slider, 'overdrive-start', ours.slider, 'overdrive-start', flags);
    let busy = false;
    const copy = (from, to) => {
        if (busy)
            return;
        busy = true;
        to.value = from.value;
        busy = false;
    };
    s.connect(theirs.slider, 'notify::value', () => copy(theirs.slider, ours.slider));
    s.connect(ours.slider, 'notify::value', () => copy(ours.slider, theirs.slider));
    copy(theirs.slider, ours.slider);
}

export const SystemSliders = GObject.registerClass(
class JoaoSystemSliders extends St.BoxLayout {
    _init(tooltip) {
        super._init({style_class: 'escenas-full-sliders', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.volume = this._row('audio-volume-high-symbolic', 'Volumen', tooltip);
        this.brightness = this._row('display-brightness-symbolic', 'Brillo', tooltip);
        this._signals = new Signals();
        this._cancelReady = whenReady(() => this._watch());
        this.connect('destroy', () => this._onDestroy());
    }

    _row(iconName, name, tooltip) {
        const row = new St.BoxLayout({style_class: 'escenas-full-slider-row', x_expand: true});
        const icon = new St.Icon({icon_name: iconName, icon_size: 17});
        const iconButton = new St.Button({
            style_class: 'escenas-full-slider-icon',
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: name,
            child: icon,
        });
        const slider = new Slider(0);
        slider.add_style_class_name('escenas-full-slider');
        slider.x_expand = true;
        slider.y_align = Clutter.ActorAlign.CENTER;
        slider.accessible_name = name;
        slider.connect('scroll-event', (a, event) => wheelSlider(slider, event));
        slider.connect('key-focus-in', () => row.add_style_class_name('focused'));
        slider.connect('key-focus-out', () => row.remove_style_class_name('focused'));
        row.add_child(iconButton);
        row.add_child(slider);
        this.add_child(row);
        tooltip.attach(iconButton, name);
        return {row, slider, iconButton, icon};
    }

    _watch() {
        const output = gnome.volumeSlider();
        mirrorSlider(this._signals, this.volume, output);
        // The speaker icon mutes, as in GNOME's menu.
        this._signals.connect(this.volume.iconButton, 'clicked', () => output?.emit('icon-clicked'));
        mirrorSlider(this._signals, this.brightness, gnome.brightnessSlider());
    }

    _onDestroy() {
        this._cancelReady();
        this._signals.disconnectAll();
    }
});
