// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The island: a floating glass piece at the top of the screen, a pill that grows into a card.
// The blur is a still picture of the screen, taken just before arriving and cut to the island's
// shape. Not Shell.BlurMode.BACKGROUND: it re-reads the screen, which on X11 + NVIDIA blurs stale
// bits (see pantalla/backdrop.js), and it has square corners behind round glass. Not live copies of
// the wallpaper and windows either: the wallpaper paints only part of itself when a window is
// around, and the glass came out split by a line.
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {pointerMonitor} from '../escenas/escenasLink.js';
import {connectKeyPress} from '../escritorio/keyEvents.js';
import {RoundedCorners} from '../franja/sceneThumbnail.js';
import {Signals} from '../sistema/gnome.js';
import {DOT, IslandAnimator, TOP} from './islandAnimator.js';
import {CardContent, PillContent} from './islandContent.js';
import {screenPicture} from './screenPicture.js';
import {sourceName} from './sourceLook.js';

const CARD_WIDTH = 380;
const PILL_HEIGHT = 40;
const PILL_RADIUS = 20;
const CARD_RADIUS = 28;
const BLUR_RADIUS = 30;
const BLUR_BRIGHTNESS = 1.0;   // Shell.BlurEffect accepts at most 1.0 (GNOME 48)
const SWIPE_AWAY = 14;      // px upwards on the pill
const SAMPLE_HEIGHT = 140;  // px from the top of the screen
const BRIGHT = 0.62;        // what is behind counts as light above this (0 to 1)
const TINT_TIME = 200;

const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

export const Island = GObject.registerClass({
    Signals: {
        settled: {},    // a movement ended: the queue may go on
        gone: {},       // completely off the screen
        hold: {},       // the pointer came in: the time stops
        release: {},    // the pointer went away
        dismiss: {},    // the user discarded it
    },
}, class JoaoIsland extends St.Widget {
    _init(settings) {
        super._init({
            style_class: 'joao-island',
            reactive: true,
            track_hover: true,
            visible: false,
            layout_manager: new Clutter.BinLayout(),
            accessible_role: Atk.Role.NOTIFICATION,
        });
        this._settings = settings;
        this._alive = true;
        this.busy = false;
        this.expanded = false;
        this._notification = null;
        this._radius = -1;

        // Behind everything; the opaque glass covers all of it but the shadow.
        this._shadow = new St.Widget({style_class: 'joao-island-shadow', x_expand: true, y_expand: true});
        this.add_child(this._shadow);

        this._glass = new St.Widget({clip_to_allocation: true, x_expand: true, y_expand: true});
        // In desktop coordinates, shifted so that what is under the island shows here.
        this._copy = new Clutter.Actor();
        this._glass.add_child(this._copy);
        // First added = outermost: the corners cut what the blur produced.
        this._mask = new RoundedCorners(1, 1, PILL_RADIUS);
        this._glass.add_effect(this._mask);
        this._glass.add_effect(new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: BLUR_RADIUS, brightness: BLUR_BRIGHTNESS}));
        this.add_child(this._glass);

        this._tint = new St.Widget({style_class: 'joao-island-tint', x_expand: true, y_expand: true, opacity: 0});
        this.add_child(this._tint);
        this._face = new St.Widget({style_class: 'joao-island-face', x_expand: true, y_expand: true});
        this.add_child(this._face);

        this._pill = new PillContent();
        this._card = new CardContent();
        this._card.visible = false;
        this.add_child(this._pill);
        this.add_child(this._card);
        this._animator = new IslandAnimator(this, this._pill, this._card);

        this._pill.connect('clicked', () => this.expand());
        this._card.connect('clicked', () => this._activate());
        this._card.connect('close-clicked', () => this.emit('dismiss'));
        this._card.connect('action-done', () => this.leave());
        this._addSwipe();

        this.connect('notify::hover', () => this._onHover());
        connectKeyPress(this, event => this._onKey(event));
        this.connect('notify::x', () => this._syncCopy());
        this.connect('notify::y', () => this._syncCopy());
        this.connect('notify::width', () => this._syncShape());
        this.connect('notify::height', () => this._syncShape());

        Main.layoutManager.addTopChrome(this);
        this._signals = new Signals();
        this._signals.connect(settings, 'changed::island-glass', () => this._syncFace());
        this._signals.connect(settings, 'changed::island-blur', () => {
            this._syncBlur();
        });
        this._syncBlur();
        this._syncFace();
    }

    // Followed by hand: Clutter's pan gestures never start on a St.Button, which takes the
    // pointer for itself on press.
    _addSwipe() {
        let startY = null;
        this._pill.connect('event', (pill, event) => {
            switch (event.type()) {
            case Clutter.EventType.BUTTON_PRESS:
            case Clutter.EventType.TOUCH_BEGIN:
                startY = event.get_coords()[1];
                break;
            case Clutter.EventType.MOTION:
            case Clutter.EventType.TOUCH_UPDATE:
                if (startY !== null && startY - event.get_coords()[1] >= SWIPE_AWAY * scaleFactor()) {
                    startY = null;
                    pill.fake_release();    // no click when the finger lifts
                    this.emit('dismiss');
                }
                break;
            case Clutter.EventType.BUTTON_RELEASE:
            case Clutter.EventType.TOUCH_END:
            case Clutter.EventType.TOUCH_CANCEL:
                startY = null;
                break;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // ---------- geometry ----------

    _monitor() {
        return Main.layoutManager.monitors[pointerMonitor()] ?? Main.layoutManager.primaryMonitor;
    }

    _place(width, height) {
        const monitor = this._monitor();
        return {center: monitor.x + monitor.width / 2, top: monitor.y + TOP * scaleFactor(), width, height};
    }

    _syncCopy() {
        // Translation: these arrive in the middle of a layout pass, which a move would disturb.
        this._copy.set({translation_x: -this.x, translation_y: -this.y});
    }

    _syncShape() {
        const scale = scaleFactor();
        // The corners follow the growth: from the pill's radius to the card's.
        const grown = Math.max(0, Math.min(1, (this.width / scale - this._pillWidth / scale) / Math.max(1, CARD_WIDTH - this._pillWidth / scale)));
        const radius = Math.min(Math.round(PILL_RADIUS + (CARD_RADIUS - PILL_RADIUS) * grown), Math.floor(this.height / scale / 2));
        this._mask.resize(this.width, this.height, radius * scale);
        if (radius === this._radius)
            return;
        this._radius = radius;
        // A new style asks for a new layout, and this runs inside one: on the next frame.
        if (!this._styleLater) {
            this._styleLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._styleLater = 0;
                const style = `border-radius: ${this._radius}px;`;
                this._shadow.style = style;
                this._tint.style = style;
                this._syncFace();
                return false;
            });
        }
    }

    get _pillWidth() {
        return this._pillWanted ?? PILL_HEIGHT * scaleFactor();
    }

    _syncFace() {
        const alpha = this._settings.get_double('island-glass');
        this._face.style = `border-radius: ${Math.max(0, this._radius)}px; background-color: rgba(255, 255, 255, ${alpha});`;
    }

    // A picture of the whole screen, so that wherever the island grows, it has what is behind it.
    async _takePicture() {
        this._clearCopy();
        if (!this._settings.get_boolean('island-blur'))
            return;
        try {
            this._copy.add_child(await screenPicture());
        } catch (e) {
            logError(e, 'João: foto bajo la isla');
        }
    }

    _clearCopy() {
        this._copy.destroy_all_children();
    }

    _syncBlur() {
        const on = this._settings.get_boolean('island-blur');
        this._glass.visible = on;
        // Without the glass over it, the shadow's solid base would show through.
        this._shadow.visible = on;
    }

    // ---------- showing ----------

    async show(notification, more) {
        const change = this.visible && this._notification;
        this._canReturn = false;
        this._setUnredirect(true);
        this.busy = true;
        this._notification = notification;
        this._more = more;
        this.expanded = false;
        this._returnFocusNow();
        if (change) {
            this._animator.change(this._place(0, DOT),
                () => this._fill(), () => this._measurePill(), () => this._settled());
            return;
        }
        Main.layoutManager.uiGroup.set_child_above_sibling(this, null);
        // Shown first, out of sight: St has no styles to measure with on hidden actors.
        this.opacity = 0;
        super.show();
        this._fill();
        const width = this._measurePill();
        const run = this._arrival = (this._arrival ?? 0) + 1;
        // Taken before it is on screen: the picture must not have the island in it.
        await this._takePicture();
        if (run !== this._arrival || !this._alive)
            return;
        this._sampleBackground();
        this._animator.arrive(this._place(width, PILL_HEIGHT * scaleFactor()), () => this._settled());
    }

    refresh() {
        if (!this._notification)
            return;
        this._fill();
        if (this.expanded) {
            this._card.fit();
            this.ease({height: this._card.wantedHeight, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    _fill() {
        this._pill.fill(this._notification, this._more);
        this._card.fill(this._notification);
        this.accessible_name = `${sourceName(this._notification.source)}: ${this._notification.title ?? ''}`;
        this.add_accessible_state(Atk.StateType.SHOWING);
    }

    _measurePill() {
        this._pillWanted = Math.max(this._pill.wantedWidth, PILL_HEIGHT * scaleFactor());
        return this._pillWanted;
    }

    _settled() {
        this.busy = false;
        this.emit('settled');
        // The pointer may have come in while it was still moving.
        this._onHover();
    }

    startLine(ms, total) {
        this._pill.runLine(ms, total);
    }

    stopLine() {
        this._pill.stopLine();
    }

    // ---------- pointer and keyboard ----------

    get holding() {
        return !!this._holding;
    }

    // Going away on its own and the pointer came in: back from wherever it had got to.
    _comeBack() {
        this._canReturn = false;
        this._holding = true;
        this.emit('hold');
        this.busy = false;
        if (this._settings.get_boolean('island-expand-on-hover')) {
            this.expand();
            return;
        }
        this.busy = true;
        this._animator.collapse(this._place(this._pillWidth, PILL_HEIGHT * scaleFactor()), () => {
            this.busy = false;
            this.emit('settled');
        });
    }

    _onHover() {
        if (this._canReturn && this.hover && this.visible) {
            this._comeBack();
            return;
        }
        if (!this.visible || !this._notification || this.busy)
            return;
        if (this.hover && !this._holding) {
            this._holding = true;
            this.emit('hold');
            if (this._settings.get_boolean('island-expand-on-hover'))
                this.expand();
        } else if (!this.hover && this._holding) {
            this._holding = false;
            if (this.expanded)
                this.collapse();
            else
                this.emit('release');
        }
    }

    expand() {
        if (!this._notification || this.expanded)
            return;
        if (!this._holding) {
            this._holding = this.hover;
            this.emit('hold');
        }
        this.expanded = true;
        this.busy = true;
        // Measured visible: St has no styles to measure with on hidden actors.
        this._card.set({opacity: 0, visible: true});
        this._card.fit();
        const place = this._place(CARD_WIDTH * scaleFactor(), this._card.wantedHeight);
        this._animator.expand(place, () => {
            this.busy = false;
            this._grabFocus();
            this.emit('settled');
            this._onHover();
        });
    }

    collapse() {
        if (!this.expanded)
            return;
        this.expanded = false;
        this.busy = true;
        this._returnFocusNow();
        this._animator.collapse(this._place(this._pillWidth, PILL_HEIGHT * scaleFactor()), () => {
            this.busy = false;
            this.emit('release');
            this.emit('settled');
            this._onHover();
        });
    }

    leave({canReturn = false} = {}) {
        if (!this.visible)
            return;
        this._arrival = (this._arrival ?? 0) + 1;
        this._canReturn = canReturn;
        this.expanded = false;
        this.busy = true;
        this._holding = false;
        this._returnFocusNow();
        this._animator.leave(this._place(DOT, DOT), () => {
            this._canReturn = false;
            this.hide();
            this._clearCopy();
            this._notification = null;
            this.busy = false;
            this._setUnredirect(false);
            this.emit('gone');
        });
    }

    openFromKeyboard() {
        if (!this.visible || !this._notification)
            return;
        if (this.expanded)
            this._grabFocus();
        else
            this.expand();
    }

    _activate() {
        this._notification?.activate();
        this.leave();
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            if (this.expanded)
                this.collapse();
            else
                this.emit('dismiss');
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _grabFocus() {
        if (this._focusBefore === undefined)
            this._focusBefore = global.stage.get_key_focus();
        this._card.grab_key_focus();
    }

    _returnFocusNow() {
        if (this._focusBefore === undefined)
            return;
        const focus = global.stage.get_key_focus();
        if (focus === this._card || this._card.contains(focus))
            global.stage.set_key_focus(this._focusBefore);
        this._focusBefore = undefined;
    }

    _setUnredirect(off) {
        if (off === !!this._unredirectOff)
            return;
        this._unredirectOff = off;
        if (off)
            global.compositor.disable_unredirect();
        else
            global.compositor.enable_unredirect();
    }

    // ---------- legibility over light windows ----------

    // How bright what is under the island is, measured once before it arrives.
    async _sampleBackground() {
        const notification = this._notification;
        this._tint.remove_all_transitions();
        this._tint.opacity = 0;
        if (!this._settings.get_boolean('island-auto-contrast'))
            return;
        try {
            const monitor = this._monitor();
            const scale = scaleFactor();
            const width = CARD_WIDTH * scale;
            // As far down as a card usually reaches: its text must read too, not only the pill's.
            const height = SAMPLE_HEIGHT * scale;
            const stream = Gio.MemoryOutputStream.new_resizable();
            const shooter = new Shell.Screenshot();
            await new Promise((resolve, reject) => {
                shooter.screenshot_area(
                    monitor.x + Math.round((monitor.width - width) / 2), monitor.y, width, height, stream,
                    (o, result) => {
                        try {
                            o.screenshot_area_finish(result);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    });
            });
            stream.close(null);
            const png = Gio.MemoryInputStream.new_from_bytes(stream.steal_as_bytes());
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(png, null).scale_simple(1, 1, GdkPixbuf.InterpType.BILINEAR);
            const [r, g, b] = pixbuf.get_pixels();
            const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            this.lastBrightness = light;
            if (this._notification === notification && light > BRIGHT)
                this._tint.ease({opacity: 255, duration: TINT_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } catch (e) {
            logError(e, 'João: brillo bajo la isla');
        }
    }

    destroy() {
        this._alive = false;
        if (this._styleLater)
            global.compositor.get_laters().remove(this._styleLater);
        this._signals.disconnectAll();
        this._clearCopy();
        this._returnFocusNow();
        this._setUnredirect(false);
        Main.layoutManager.removeChrome(this);
        super.destroy();
    }
});
