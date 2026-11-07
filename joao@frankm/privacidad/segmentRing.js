// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The launcher button's ring: one coloured segment per device in use (screen, microphone,
// camera), and the timer's lilac arc. Segments share the ring by weight, so one coming or going
// makes room smoothly, and the whole ring turns slowly while a device is in use (with the timer
// alone it turns back so the arc starts at the top). It only animates while something moves.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

// The order of the segments and of the card's rows.
export const RING_ORDER = ['screen', 'microphone', 'camera'];
// The ring's timer (anillo/) is one more segment, last, lilac; it is as long as what is left.
const ORDER = [...RING_ORDER, 'timer'];
export const DEVICE_RGB = {
    screen: [0xe2, 0x4b, 0x4a],
    microphone: [0xef, 0x9f, 0x27],
    camera: [0x1d, 0x9e, 0x75],
    timer: [0xaf, 0xa9, 0xec],
};

const LINE = 3.5;
const GAP = 0.38;             // rad between segments, with two or more
const EASE = 7;               // weight approach per second
const TURN = 0.25;            // rad/s while something is in use
const TRACK_ALPHA = 0.16;
const SETTLED = 0.001;

export const SegmentRing = GObject.registerClass(
class JoaoSegmentRing extends St.DrawingArea {
    // radius: of the ring's centre line, in logical px.
    _init(radius, params = {}) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const size = Math.ceil(2 * radius + LINE + 2) * scale;
        super._init({width: size, height: size, ...params});
        this._radius = radius;
        this._weights = Object.fromEntries(ORDER.map(d => [d, 0]));
        this._targets = Object.fromEntries(ORDER.map(d => [d, 0]));
        this._timerFraction = 1;
        this._rotation = 0;
        this._last = 0;
        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._step());
        this.connect('repaint', () => this._paint());
        this.connect('destroy', () => {
            this._timeline.stop();
            this._timeline = null;
        });
    }

    get _animated() {
        return St.Settings.get().enable_animations;
    }

    // A device in use: the ring turns.
    get _anyOn() {
        return RING_ORDER.some(d => this._targets[d] > 0);
    }

    // devices: those in use now.
    setActive(devices) {
        for (const d of RING_ORDER)
            this._targets[d] = devices.includes(d) ? 1 : 0;
        this._retarget();
    }

    // fraction: what is left of the timer (1 → 0), or null when there is none.
    setTimer(fraction) {
        const on = fraction !== null && fraction !== undefined;
        this._timerFraction = on ? Math.max(0, Math.min(1, fraction)) : this._timerFraction;
        const changed = this._targets.timer !== (on ? 1 : 0);
        this._targets.timer = on ? 1 : 0;
        if (changed)
            this._retarget();
        else
            this.queue_repaint();
    }

    get timerOn() {
        return this._targets.timer > 0;
    }

    _retarget() {
        if (!this._animated) {
            Object.assign(this._weights, this._targets);
            if (!this._anyOn)
                this._rotation = 0;
            this._timeline?.stop();
            this.queue_repaint();
            return;
        }
        if (!this._settled || this._anyOn)
            this._start();
    }

    // With nothing turning it, the ring is back at the top.
    get _settled() {
        return ORDER.every(d => Math.abs(this._weights[d] - this._targets[d]) < SETTLED) &&
            (this._anyOn || this._rotation === 0);
    }

    _start() {
        if (!this._timeline || this._timeline.is_playing())
            return;
        this._last = 0;
        this._timeline.start();
    }

    _step() {
        const now = GLib.get_monotonic_time() / 1000;
        const dt = this._last ? Math.min(0.05, Math.max(0, now - this._last) / 1000) : 0;
        this._last = now;
        const k = Math.min(1, dt * EASE);
        if (this._anyOn) {
            this._rotation = (this._rotation + dt * TURN) % (2 * Math.PI);
        } else if (this._rotation !== 0) {
            // The shortest way back to the top.
            const back = this._rotation > Math.PI ? this._rotation - 2 * Math.PI : this._rotation;
            const next = back * (1 - k);
            this._rotation = Math.abs(next) < 0.002 ? 0 : (next + 2 * Math.PI) % (2 * Math.PI);
        }
        for (const d of ORDER) {
            this._weights[d] += (this._targets[d] - this._weights[d]) * k;
            if (Math.abs(this._weights[d] - this._targets[d]) < SETTLED)
                this._weights[d] = this._targets[d];
        }
        this.queue_repaint();
        // Nothing in use and every segment gone: no more frames.
        if (!this._anyOn && this._settled)
            this._timeline.stop();
    }

    // [[device, start, end], …] in radians, like the reference demo's frame().
    get segments() {
        const total = ORDER.reduce((sum, d) => sum + this._weights[d], 0);
        if (total < SETTLED)
            return [];
        const shown = ORDER.filter(d => this._weights[d] > 0.02).length;
        const gap = shown > 1 ? GAP : 0;
        const full = 2 * Math.PI;
        let angle = -Math.PI / 2 + this._rotation;
        const out = [];
        for (const d of ORDER) {
            const w = this._weights[d];
            if (w < 0.005)
                continue;
            const span = (w / Math.max(1, total)) * full * Math.min(1, total);
            const g = gap * Math.min(1, w);
            // The timer only fills the part of its place that is still to go.
            const length = (span - g) * (d === 'timer' ? this._timerFraction : 1);
            out.push([d, angle + g / 2, angle + g / 2 + length]);
            angle += span;
        }
        return out;
    }

    _paint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const radius = this._radius * scale;
        cr.translate(width / 2, height / 2);
        cr.setLineWidth(LINE * scale);
        cr.setLineCap(1);   // Cairo.LineCap.ROUND

        cr.setSourceRGBA(1, 1, 1, TRACK_ALPHA);
        cr.arc(0, 0, radius, 0, 2 * Math.PI);
        cr.stroke();

        for (const [device, start, end] of this.segments) {
            if (end - start < 0.001)
                continue;
            const [r, g, b] = DEVICE_RGB[device];
            cr.setSourceRGBA(r / 255, g / 255, b / 255, 1);
            cr.newSubPath();
            cr.arc(0, 0, radius, start, Math.min(end, start + 2 * Math.PI - 0.001));
            cr.stroke();
        }
        cr.$dispose();
    }
});
