// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// A window already in its new place is drawn as if it were still in the old one and eases
// over, so it travels instead of jumping. Only looks: the real geometry has already changed.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

const TIME = 260;

export function glide(win, from) {
    const actor = win.get_compositor_private();
    if (!actor || win.minimized || !St.Settings.get().enable_animations)
        return;
    const to = win.get_frame_rect();
    if (from.x === to.x && from.y === to.y && from.width === to.width && from.height === to.height)
        return;
    actor.remove_all_transitions();
    actor.set_pivot_point(0, 0);
    actor.translation_x = from.x - to.x;
    actor.translation_y = from.y - to.y;
    actor.scale_x = from.width / to.width;
    actor.scale_y = from.height / to.height;
    actor.ease({
        translation_x: 0,
        translation_y: 0,
        scale_x: 1,
        scale_y: 1,
        duration: TIME,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
    });
}
