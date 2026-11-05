// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The page's elements arriving one after another: those near the point first. Only what is on
// the first screen is animated; what is further down the page just waits there.
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';

const FADE_TIME = 320;
const MOVE_TIME = 460;
const BASE_DELAY = 80;
const DELAY_PER_PIXEL = 0.3;
const MAX_DELAY = 560;      // the far corner of a big screen does not lag behind the circle
const PULL = 0.04;          // starts this part of the way towards the point
const START_SCALE = 0.92;
const SETTLE_TIME = 200;
const FINAL = {opacity: 255, translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1};

export class Stagger {
    constructor() {
        this._items = new Set();
    }

    _track(item) {
        this._items.add(item);
        item.connectObject('destroy', () => this._items.delete(item), this);
    }

    // @actors must be laid out; @origin and @bottom are stage coordinates.
    enter(actors, origin, bottom) {
        for (const item of actors) {
            if (!item.mapped)
                continue;
            const [x, y] = item.get_transformed_position();
            if (y >= bottom)
                continue;
            const [width, height] = item.get_transformed_size();
            const dx = origin.x - (x + width / 2);
            const dy = origin.y - (y + height / 2);
            const delay = Math.min(MAX_DELAY, BASE_DELAY + Math.hypot(dx, dy) * DELAY_PER_PIXEL);
            this._track(item);
            item.pivot_point = new Graphene.Point({x: 0.5, y: 0.5});
            item.set({opacity: 0, translation_x: dx * PULL, translation_y: dy * PULL,
                scale_x: START_SCALE, scale_y: START_SCALE});
            item.ease({opacity: 255, delay, duration: FADE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            item.ease({translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1, delay, duration: MOVE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }
    }

    // One element with its own entrance (the system panel).
    enterFromSide(item, shift, delay, duration) {
        if (!item.mapped)
            return;
        this._track(item);
        item.set({opacity: 0, translation_x: shift});
        item.ease({opacity: 255, translation_x: 0, delay, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // Stops where they are, so the page can fade with them as they were.
    freeze() {
        this._items.forEach(item => item.remove_all_transitions());
    }

    // Opening again half-way: everything goes to its place from wherever it is, without waiting.
    settle() {
        for (const item of this._items) {
            item.remove_all_transitions();
            item.ease({...FINAL, duration: SETTLE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    reset() {
        for (const item of this._items) {
            item.remove_all_transitions();
            item.set(FINAL);
            item.disconnectObject(this);
        }
        this._items.clear();
    }
}
