// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The icons of the six switches, each with its own animation when it turns on (dark mode and
// airplane also when they turn off). Wi-Fi, Bluetooth and the bulb are drawn with Cairo so their
// parts can come in one by one; the moon, the bell and the plane are GNOME's icons moved as a whole.
// All of them draw in the text colour of the switch, so they turn blue when the switch is on.
// With "Animaciones" off in Accessibility the state changes at once.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

export const animations = () => St.Settings.get().enable_animations;
const SIZE = 24;
const clamp = x => Math.max(0, Math.min(1, x));
const easeOut = x => 1 - (1 - x) ** 3;

// Runs onFrame(ms) for @duration ms on @actor's frame clock; returns a stop function.
export function run(actor, duration, onFrame, onDone = null) {
    const timeline = new Clutter.Timeline({actor, duration});
    timeline.connect('new-frame', (t, ms) => onFrame(ms));
    timeline.connect('completed', () => {
        onFrame(duration);
        onDone?.();
    });
    timeline.start();
    return () => {
        if (timeline.is_playing())
            timeline.stop();
    };
}

// Eases @actor through @steps ([{...props, duration, mode}]) one after another.
export function sequence(actor, steps, onDone = null) {
    const [first, ...rest] = steps;
    if (!first) {
        onDone?.();
        return;
    }
    actor.ease({mode: Clutter.AnimationMode.EASE_OUT_QUAD, ...first,
        onComplete: () => sequence(actor, rest, onDone)});
}

function color(cr, area, alpha = 1) {
    const c = area.get_theme_node().get_foreground_color();
    cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, alpha * c.alpha / 255);
}

function drawingArea(paint) {
    const area = new St.DrawingArea({width: SIZE, height: SIZE});
    area.connect('repaint', () => {
        const cr = area.get_context();
        cr.setLineCap(1);   // round
        cr.setLineJoin(1);
        paint(cr, area);
        cr.$dispose();
    });
    area.connect('style-changed', () => area.queue_repaint());
    return area;
}

class AnimatedIcon {
    constructor() {
        this.actor = new St.Widget({width: SIZE, height: SIZE, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        this.on = false;
        this._stop = null;
    }

    _icon(name, size = 18) {
        const icon = new St.Icon({icon_name: name, icon_size: size, x: (SIZE - size) / 2, y: (SIZE - size) / 2,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        this.actor.add_child(icon);
        return icon;
    }

    _run(duration, onFrame, onDone) {
        this._stop?.();
        this._stop = run(this.actor, duration, onFrame, () => {
            this._stop = null;
            onDone?.();
        });
    }

    // @animate: false for the first sync and while animations are off.
    setOn(on, animate) {
        this.on = on;
        this._stop?.();
        this._stop = null;
        if (animate && animations())
            this._animate(on);
        else
            this._settle(on);
    }

    _animate(on) {
        this._settle(on);
    }

    _settle() {}
}

// The dot and the three arcs come in from the inside out.
class WifiIcon extends AnimatedIcon {
    constructor() {
        super();
        this._parts = [1, 1, 1, 1];
        this._area = drawingArea((cr, area) => {
            const cx = 12, cy = 19.5;
            this._parts.forEach((p, i) => {
                if (p <= 0)
                    return;
                color(cr, area, p);
                const dy = 3 * (1 - p);
                if (i === 0) {
                    cr.arc(cx, cy + dy, 1.9, 0, 2 * Math.PI);
                    cr.fill();
                    return;
                }
                cr.setLineWidth(2);
                cr.arc(cx, cy + dy, 1 + 4 * i, -Math.PI * 0.77, -Math.PI * 0.23);
                cr.stroke();
            });
        });
        this.actor.add_child(this._area);
    }

    _animate(on) {
        if (!on)
            return this._settle(on);
        this._run(4 * 110 + 220, ms => {
            this._parts = this._parts.map((_, i) => easeOut(clamp((ms - 110 * i) / 220)));
            this._area.queue_repaint();
        });
        return undefined;
    }

    _settle() {
        this._parts = [1, 1, 1, 1];
        this._area.queue_repaint();
    }
}

// The rune is drawn stroke by stroke.
const BT = [[7, 8], [17, 16], [12, 20], [12, 4], [17, 8], [7, 16]];
class BluetoothIcon extends AnimatedIcon {
    constructor() {
        super();
        this._progress = 1;
        const lengths = BT.slice(1).map((p, i) => Math.hypot(p[0] - BT[i][0], p[1] - BT[i][1]));
        const total = lengths.reduce((a, b) => a + b, 0);
        this._area = drawingArea((cr, area) => {
            color(cr, area);
            cr.setLineWidth(1.9);
            let left = total * this._progress;
            cr.moveTo(...BT[0]);
            for (let i = 1; i < BT.length && left > 0; i++) {
                const f = Math.min(1, left / lengths[i - 1]);
                const [x0, y0] = BT[i - 1], [x1, y1] = BT[i];
                cr.lineTo(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
                left -= lengths[i - 1];
            }
            cr.stroke();
        });
        this.actor.add_child(this._area);
    }

    _animate(on) {
        if (!on)
            return this._settle(on);
        this._run(650, ms => {
            this._progress = Math.max(0.001, easeOut(ms / 650));
            this._area.queue_repaint();
        });
        return undefined;
    }

    _settle() {
        this._progress = 1;
        this._area.queue_repaint();
    }
}

// A four-pointed sparkle.
function star(size) {
    return drawingArea((cr, area) => {
        color(cr, area);
        const c = size / 2, r = size / 2, k = r * 0.28;
        cr.moveTo(c, c - r);
        cr.curveTo(c + k, c - k, c + k, c - k, c + r, c);
        cr.curveTo(c + k, c + k, c + k, c + k, c, c + r);
        cr.curveTo(c - k, c + k, c - k, c + k, c - r, c);
        cr.curveTo(c - k, c - k, c - k, c - k, c, c - r);
        cr.fill();
    });
}

// The moon turns in with a small bounce (both ways); two stars show up while it is on.
class DarkIcon extends AnimatedIcon {
    constructor() {
        super();
        this._moon = this._icon('weather-clear-night-symbolic', 17);
        this._stars = [[17, 1, 6], [21, 8, 4]].map(([x, y, size]) => {
            const s = star(size);
            s.set({x, y, width: size, height: size, opacity: 0, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
            this.actor.add_child(s);
            return s;
        });
    }

    _animate(on) {
        this._moon.remove_all_transitions();
        this._moon.rotation_angle_z = -70;
        this._moon.ease({rotation_angle_z: 0, duration: 600, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        this._stars.forEach((s, i) => {
            s.remove_all_transitions();
            if (on) {
                s.set({opacity: 0, scale_x: 0.3, scale_y: 0.3});
                s.ease({opacity: 255, scale_x: 1, scale_y: 1, delay: [300, 420][i], duration: 300,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK});
            } else {
                s.ease({opacity: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        });
    }

    _settle(on) {
        this._moon.remove_all_transitions();
        this._moon.rotation_angle_z = 0;
        this._stars.forEach(s => {
            s.remove_all_transitions();
            s.set({opacity: on ? 255 : 0, scale_x: 1, scale_y: 1});
        });
    }
}

// The bell swings from its top, then a slash crosses it out (it stays while on).
class BellIcon extends AnimatedIcon {
    constructor() {
        super();
        this._bell = this._icon('preferences-system-notifications-symbolic', 17);
        this._bell.pivot_point = new Graphene.Point({x: 0.5, y: 0.05});
        this._slash = 0;
        this._area = drawingArea((cr, area) => {
            if (this._slash <= 0)
                return;
            const [x0, y0, x1, y1] = [4, 4, 20, 20];
            const x = x0 + (x1 - x0) * this._slash, y = y0 + (y1 - y0) * this._slash;
            // A cut in the switch's own background first, so the line reads over the bell.
            const bg = area.get_parent().get_parent().get_theme_node().get_background_color();
            cr.setSourceRGBA(bg.red / 255, bg.green / 255, bg.blue / 255, bg.alpha / 255);
            cr.setLineWidth(4.5);
            cr.moveTo(x0, y0);
            cr.lineTo(x, y);
            cr.stroke();
            color(cr, area);
            cr.setLineWidth(2);
            cr.moveTo(x0, y0);
            cr.lineTo(x, y);
            cr.stroke();
        });
        this.actor.add_child(this._area);
    }

    _animate(on) {
        if (!on)
            return this._settle(on);
        this._slash = 0;
        this._area.queue_repaint();
        this._bell.remove_all_transitions();
        const angles = [22, -18, 12, -8, 4, 0];
        sequence(this._bell, angles.map(a => ({rotation_angle_z: a, duration: 800 / angles.length,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE})), () => {
            if (!this.on)
                return;
            this._run(380, ms => {
                this._slash = Math.max(0.001, easeOut(ms / 380));
                this._area.queue_repaint();
            });
        });
        return undefined;
    }

    _settle(on) {
        this._bell.remove_all_transitions();
        this._bell.rotation_angle_z = 0;
        this._slash = on ? 1 : 0;
        this._area.queue_repaint();
    }
}

// The bulb gets an amber halo that stays while on, and three rays come out one after another.
const AMBER = [1, 0xcf / 255, 0x6b / 255];
class BulbIcon extends AnimatedIcon {
    constructor() {
        super();
        this._halo = 0;
        this._rays = [0, 0, 0];
        this._area = drawingArea((cr, area) => {
            const cx = 12, cy = 12.5;
            if (this._halo > 0) {
                const g = new Cairo.RadialGradient(cx, cy, 1, cx, cy, 11);
                g.addColorStopRGBA(0, ...AMBER, 0.85 * this._halo);
                g.addColorStopRGBA(1, ...AMBER, 0);
                cr.setSource(g);
                cr.arc(cx, cy, 11, 0, 2 * Math.PI);
                cr.fill();
            }
            color(cr, area);
            cr.setLineWidth(1.8);
            cr.arc(cx, cy - 1, 4.6, Math.PI * 0.8, Math.PI * 2.2);
            cr.lineTo(cx + 2, cy + 5);
            cr.lineTo(cx - 2, cy + 5);
            cr.closePath();
            cr.stroke();
            cr.moveTo(cx - 1.8, cy + 7.3);
            cr.lineTo(cx + 1.8, cy + 7.3);
            cr.stroke();
            this._rays.forEach((p, i) => {
                if (p <= 0)
                    return;
                const a = (-150 + 60 * i) * Math.PI / 180;
                const r0 = 7.2, r1 = 7.2 + 3 * p;
                cr.moveTo(cx + r0 * Math.cos(a), cy - 1 + r0 * Math.sin(a));
                cr.lineTo(cx + r1 * Math.cos(a), cy - 1 + r1 * Math.sin(a));
                cr.stroke();
            });
        });
        this.actor.add_child(this._area);
    }

    _animate(on) {
        if (!on)
            return this._settle(on);
        this._run(260 + 3 * 140, ms => {
            this._halo = easeOut(clamp(ms / 300));
            this._rays = this._rays.map((_, i) => easeOut(clamp((ms - 200 - 140 * i) / 200)));
            this._area.queue_repaint();
        });
        return undefined;
    }

    _settle(on) {
        this._halo = on ? 1 : 0;
        this._rays = [on ? 1 : 0, on ? 1 : 0, on ? 1 : 0];
        this._area.queue_repaint();
    }
}

// The plane flies out through the top right corner and comes back in through the bottom left.
class PlaneIcon extends AnimatedIcon {
    constructor() {
        super();
        this._plane = this._icon('airplane-mode-symbolic', 17);
    }

    _animate() {
        const p = this._plane;
        p.remove_all_transitions();
        p.ease({translation_x: 26, translation_y: -26, opacity: 0, duration: 400,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                p.set({translation_x: -26, translation_y: 26});
                p.ease({translation_x: 0, translation_y: 0, opacity: 255, duration: 500,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            }});
    }

    _settle() {
        this._plane.remove_all_transitions();
        this._plane.set({translation_x: 0, translation_y: 0, opacity: 255});
    }
}

const ICONS = {
    'wifi': WifiIcon,
    'bluetooth': BluetoothIcon,
    'dark': DarkIcon,
    'dnd': BellIcon,
    'night-light': BulbIcon,
    'airplane': PlaneIcon,
};

export function makeIcon(id) {
    return new ICONS[id]();
}

// ---------- the sliders' icons ----------

// The speaker with 1, 2 or 3 waves by level (> 0 %, > 40 %, > 75 %), or crossed out when muted.
export class SpeakerIcon {
    constructor() {
        this.level = 0;
        this.muted = false;
        this.actor = drawingArea((cr, area) => {
            color(cr, area);
            cr.setLineWidth(1.7);
            cr.moveTo(3, 9.5);
            cr.lineTo(6.5, 9.5);
            cr.lineTo(11, 5.5);
            cr.lineTo(11, 18.5);
            cr.lineTo(6.5, 14.5);
            cr.lineTo(3, 14.5);
            cr.closePath();
            cr.fill();
            if (this.muted) {
                cr.moveTo(15, 9);
                cr.lineTo(21, 15);
                cr.moveTo(21, 9);
                cr.lineTo(15, 15);
                cr.stroke();
                return;
            }
            const waves = this.level > 0.75 ? 3 : this.level > 0.4 ? 2 : this.level > 0 ? 1 : 0;
            for (let i = 0; i < waves; i++) {
                cr.arc(11, 12, 3.6 + 3.3 * i, -Math.PI / 3.4, Math.PI / 3.4);
                cr.stroke();
            }
        });
    }

    set(level, muted) {
        if (level === this.level && muted === this.muted)
            return;
        this.level = level;
        this.muted = muted;
        this.actor.queue_repaint();
    }
}

// The sun turns brightness × 1.8° and its disc grows with the level.
export class SunIcon {
    constructor() {
        this.level = 0.5;
        this.actor = drawingArea((cr, area) => {
            color(cr, area);
            const c = SIZE / 2;
            cr.arc(c, c, 2.6 + 2.4 * this.level, 0, 2 * Math.PI);
            cr.fill();
            cr.setLineWidth(1.7);
            for (let i = 0; i < 8; i++) {
                const a = i * Math.PI / 4;
                cr.moveTo(c + 7.4 * Math.cos(a), c + 7.4 * Math.sin(a));
                cr.lineTo(c + 9.8 * Math.cos(a), c + 9.8 * Math.sin(a));
            }
            cr.stroke();
        });
        this.actor.pivot_point = new Graphene.Point({x: 0.5, y: 0.5});
    }

    set(level) {
        this.level = level;
        this.actor.rotation_angle_z = level * 180;
        this.actor.queue_repaint();
    }
}
