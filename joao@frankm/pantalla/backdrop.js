// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The blurred screen behind the page: the wallpaper of the page's monitor, and nothing else.
// A wallpaper of its own: GNOME's does not paint what the windows cover, so a copy of it has
// holes the shape of the windows, and the windows show through them as a rectangle smaller
// than the screen. Not Shell.BlurMode.BACKGROUND either: that re-reads the screen, and with
// partial redraws (seen on X11 + NVIDIA) it blurs stale bits of the page.
// The wallpaper sits in a layer scaled by a hair. Mutter paints a wallpaper that lines up 1 : 1
// with the screen only inside the area being redrawn in that frame; the blur keeps that paint
// until the wallpaper changes, so on a monitor at (0, 0) with partial redraws (Wayland + NVIDIA)
// the windows showed through the parts left out. Scaled, Mutter paints all of it.
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';

const OVERSCAN = 1.002;   // 2 px more on a 1920 px screen, hidden by the blur and the clip

export const Backdrop = GObject.registerClass(
class JoaoBackdrop extends St.Widget {
    _init() {
        super._init({clip_to_allocation: true});
        this.add_effect(new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 40, brightness: 1}));
        this._wallpaper = new St.Widget({pivot_point: new Graphene.Point({x: 0.5, y: 0.5}), scale_x: OVERSCAN, scale_y: OVERSCAN});
        this.add_child(this._wallpaper);
        this.connect('destroy', () => this.clear());
    }

    rebuild(monitorIndex, width, height) {
        this.clear();
        this.set_size(width, height);
        this._wallpaper.set_size(width, height);
        this._manager = new Background.BackgroundManager({
            container: this._wallpaper,
            monitorIndex,
            controlPosition: false,
        });
    }

    clear() {
        this._manager?.destroy();
        this._manager = null;
    }
});
