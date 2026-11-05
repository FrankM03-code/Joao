// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The island's movements. Every one starts from wherever the island is right now, so any of
// them can interrupt another without a jump; a movement that gets interrupted does not finish.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

const SPRING = Clutter.AnimationMode.EASE_OUT_BACK;
const SOFT = Clutter.AnimationMode.EASE_OUT_QUAD;
const SOFT_BOTH = Clutter.AnimationMode.EASE_IN_OUT_QUAD;

export const OUTSIDE = -56;
export const DOT = 40;
export const TOP = 14;

const px = value => value * St.ThemeContext.get_for_stage(global.stage).scale_factor;

export class IslandAnimator {
    // @actor: moved and resized. @pill, @card: their contents, faded in turn.
    constructor(actor, pill, card) {
        this._actor = actor;
        this._pill = pill;
        this._card = card;
        this._run = 0;
    }

    _stop() {
        this._run++;
        for (const actor of [this._actor, this._pill, this._card])
            actor.remove_all_transitions();
        return this._run;
    }

    // Each property with its own time; @done when the longest ends, unless interrupted.
    _move(moves, done) {
        const run = this._run;
        const longest = Math.max(...moves.map(m => m.duration + (m.delay ?? 0)));
        let doneOnce = false;
        moves.forEach(({actor = this._actor, props, duration, delay = 0, mode}) => {
            const last = duration + delay === longest && !doneOnce;
            doneOnce ||= last;
            actor.ease({
                ...props,
                duration,
                delay,
                mode,
                onComplete: last && done ? () => {
                    if (run === this._run)
                        done();
                } : undefined,
            });
        });
    }

    // Hidden → pill: from above the screen, stretching from a dot.
    arrive(place, done) {
        this._stop();
        this._pill.set({opacity: 255, visible: true, translation_y: 0});
        this._card.set({opacity: 0, visible: false});
        this._actor.set({opacity: 0, y: place.top + px(OUTSIDE - TOP), width: px(DOT), height: px(DOT), x: place.center - px(DOT) / 2});
        this._move([
            {props: {y: place.top}, duration: 520, mode: SPRING},
            {props: {width: place.width, x: place.center - place.width / 2}, duration: 480, mode: SPRING},
            {props: {opacity: 255}, duration: 160, mode: Clutter.AnimationMode.LINEAR},
        ], done);
    }

    // Pill → card.
    expand(place, done) {
        this._stop();
        this._card.set({visible: true, opacity: 0, translation_y: px(-6)});
        this._move([
            {props: {width: place.width, height: place.height, x: place.center - place.width / 2, y: place.top}, duration: 460, mode: SPRING},
            {props: {opacity: 255}, duration: 255, mode: Clutter.AnimationMode.LINEAR},
            {actor: this._pill, props: {opacity: 0}, duration: 160, mode: Clutter.AnimationMode.LINEAR},
            {actor: this._card, props: {opacity: 255, translation_y: 0}, duration: 320, delay: 140, mode: SOFT},
        ], () => {
            this._pill.hide();
            done?.();
        });
    }

    // Card → pill.
    collapse(place, done) {
        this._stop();
        this._pill.show();
        this._move([
            {props: {width: place.width, height: px(DOT), x: place.center - place.width / 2, y: place.top, opacity: 255}, duration: 360, mode: SOFT_BOTH},
            {actor: this._card, props: {opacity: 0}, duration: 160, mode: Clutter.AnimationMode.LINEAR},
            {actor: this._pill, props: {opacity: 255}, duration: 160, delay: 120, mode: Clutter.AnimationMode.LINEAR},
        ], () => {
            this._card.hide();
            done?.();
        });
    }

    // Pill → dot → away.
    leave(place, done) {
        this._stop();
        const run = this._run;
        this._move([
            {props: {width: px(DOT), height: px(DOT), x: place.center - px(DOT) / 2}, duration: 240, mode: SOFT_BOTH},
            {actor: this._pill, props: {opacity: 0}, duration: 120, mode: Clutter.AnimationMode.LINEAR},
            {actor: this._card, props: {opacity: 0}, duration: 120, mode: Clutter.AnimationMode.LINEAR},
        ], () => {
            if (run !== this._run)
                return;
            this._move([{props: {y: place.top + px(OUTSIDE - TOP), opacity: 0}, duration: 260, mode: SOFT_BOTH}], done);
        });
    }

    // Another one arrives with the island showing: shrink to the dot, change, stretch out again.
    change(place, swap, wantedWidth, done) {
        this._stop();
        const run = this._run;
        this._move([
            {props: {width: px(DOT), height: px(DOT), x: place.center - px(DOT) / 2, y: place.top, opacity: 255}, duration: 240, mode: SOFT_BOTH},
            {actor: this._pill, props: {opacity: 0}, duration: 120, mode: Clutter.AnimationMode.LINEAR},
            {actor: this._card, props: {opacity: 0}, duration: 120, mode: Clutter.AnimationMode.LINEAR},
        ], () => {
            if (run !== this._run)
                return;
            swap();
            this._card.hide();
            this._pill.show();
            const width = wantedWidth();
            this._move([
                {props: {width, x: place.center - width / 2}, duration: 480, mode: SPRING},
                {actor: this._pill, props: {opacity: 255}, duration: 160, mode: Clutter.AnimationMode.LINEAR},
            ], done);
        });
    }
}
