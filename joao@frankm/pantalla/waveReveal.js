// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Shows an actor only inside a circle that grows from a point or shrinks back to it. A real mask
// (a shader), so the blurred background travels with the circle. Off when it is not animating:
// the page then paints without any extra cost.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {ShaderEffect} from '../sistema/compat.js';

const GROW_TIME = 500;
const SHRINK_TIME = 380;
const SHRINK_DELAY = 60;    // the content starts fading first
const EDGE = 1.5;           // soft edge, in pixels
const NAME = 'joao-wave';
const TRANSITION = `@effects.${NAME}.radius`;

const DECLARATIONS = `
uniform vec2 center;
uniform vec2 size;
uniform float radius;
`;
const CODE = `
float away = distance(cogl_tex_coord_in[0].xy * size, center);
cogl_color_out *= 1.0 - smoothstep(radius - ${EDGE.toFixed(1)}, radius, away);
`;

const WaveEffect = GObject.registerClass({
    Properties: {
        'radius': GObject.ParamSpec.float('radius', null, null, GObject.ParamFlags.READWRITE, 0, 100000, 0),
    },
}, class JoaoWaveEffect extends ShaderEffect {
    static SNIPPET = {declarations: DECLARATIONS, code: CODE};

    _init(params) {
        this._radius = 0;
        super._init(params);
    }

    get radius() {
        return this._radius;
    }

    set radius(value) {
        if (this._radius === value)
            return;
        this._radius = value;
        this.setUniform('radius', 1, [value]);
        this.queue_repaint();
        this.notify('radius');
    }

    setArea(x, y, width, height) {
        this.setUniform('center', 2, [x, y]);
        this.setUniform('size', 2, [width, height]);
    }
});

export class WaveReveal {
    constructor(actor) {
        this._actor = actor;
        this._effect = new WaveEffect();
        this._effect.enabled = false;
        actor.add_effect_with_name(NAME, this._effect);
    }

    get active() {
        return this._effect.enabled;
    }

    get radius() {
        return this._effect.radius;
    }

    // The circle's center and the size of the actor, in the actor's own pixels.
    setArea(x, y, width, height) {
        this._effect.setArea(x, y, width, height);
        this._full = Math.ceil(Math.max(Math.hypot(x, y), Math.hypot(width - x, y),
            Math.hypot(x, height - y), Math.hypot(width - x, height - y))) + 2;
    }

    // Nothing shown yet: the next grow() starts from the point.
    prepare() {
        this.stop();
        this._effect.radius = 0;
        this._effect.enabled = true;
    }

    grow(onDone) {
        this._actor.ease_property(TRANSITION, this._full, {
            duration: GROW_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: finished => {
                if (!finished)
                    return;
                this._effect.enabled = false;
                onDone?.();
            },
        });
    }

    shrink(onDone) {
        if (!this._effect.enabled) {
            this._effect.radius = this._full;
            this._effect.enabled = true;
        }
        this._actor.ease_property(TRANSITION, 0, {
            delay: SHRINK_DELAY,
            duration: SHRINK_TIME,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            onStopped: finished => {
                if (finished)
                    onDone();
            },
        });
    }

    stop() {
        this._actor.remove_transition(TRANSITION);
        this._effect.enabled = false;
    }
}
