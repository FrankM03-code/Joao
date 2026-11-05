// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The blurred screen behind the page: the wallpaper of the page's monitor, and nothing else.
// A wallpaper of its own: GNOME's does not paint what the windows cover, so a copy of it has
// holes the shape of the windows, and the windows show through them as a rectangle smaller
// than the screen. Not Shell.BlurMode.BACKGROUND either: that re-reads the screen, and with
// partial redraws (X11 + NVIDIA on Frank's PC) it blurs stale bits of the page.
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';

export const Backdrop = GObject.registerClass(
class JoaoBackdrop extends St.Widget {
    _init() {
        super._init({clip_to_allocation: true});
        this.add_effect(new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 40, brightness: 1}));
        this.connect('destroy', () => this.clear());
    }

    rebuild(monitorIndex, width, height) {
        this.clear();
        this.set_size(width, height);
        this._manager = new Background.BackgroundManager({
            container: this,
            monitorIndex,
            controlPosition: false,
        });
    }

    clear() {
        this._manager?.destroy();
        this._manager = null;
    }
});
