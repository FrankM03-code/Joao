// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// One thumbnail of the strip: a fan of up to three window pictures (front =
// the window shown first; the ones behind are smaller, darker, and shifted
// inwards and up), the app icon badge, a window count, and the scene's name.
//
// "Turning the pile": with several windows the user
// picks which one is in front without opening the scene (mouse wheel, the
// arrows shown on hover, ←/→ with the keyboard); dots under the pile say which
// of them it is and the label shows its title. Click = put the scene on stage
// with that window focused; drag it to the middle of the screen = join it to
// the scene on stage.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import {ShaderEffect} from '../sistema/compat.js';
import {FAN_LAYERS, FAN_X, FAN_Y, STACK_HEIGHT, STACK_WIDTH, THUMB_HEIGHT, THUMB_WIDTH,
    sceneColor} from './layout.js';
import {PrivacyMarks} from './privacyBadges.js';

const RADIUS = 10;
const HOVER_TIME = 160;
const LAYER_SHRINK = 0.08;   // each layer behind: 8 % smaller…
const LAYER_SHADE = 0.2;     // …and 20 % darker
const ROTATE_TIME = 180;
const STEP_GAP = 120;        // ms: a single wheel gesture moves one window, not several
const RESET_DELAY = 1500;    // pointer away this long: the pile goes back to the most recent window
const FADE_TIME = 150;       // arrows, hint and dots
const SCROLL_STEP = 1.0;     // smooth scrolling (touchpads): accumulated delta per step
const MAX_DOTS = 5;          // more windows: "2 / 7" instead of dots
const DOT = 7;
const DOT_ACTIVE = 18;
const DOT_DIM = Math.round(255 * 0.45);
// Rows a thumbnail with several windows adds under its pile (dots and the
// hover hint; the hint's line is always kept so nothing jumps on hover).
export const PILE_EXTRA_HEIGHT = 12 + 15;

// Rounds the corners of whatever it is applied to (window pictures).
export const RoundedCorners = GObject.registerClass(
class RoundedCorners extends ShaderEffect {
    static SNIPPET = {
        declarations: 'uniform vec2 size;\nuniform float radius;\n',
        code: `vec2 p = cogl_tex_coord_in[0].xy * size;
             vec2 q = min(p, size - p);
             if (q.x < radius && q.y < radius) {
                 float d = length(vec2(radius) - q);
                 cogl_color_out *= clamp(radius - d + 0.5, 0.0, 1.0);
             }`,
    };

    _init(width, height, radius) {
        super._init();
        this._setShape(width, height, radius);
    }

    _setShape(width, height, radius) {
        this.setUniform('size', 2, [width, height]);
        this.setUniform('radius', 1, [radius]);
    }

    resize(width, height, radius) {
        this._setShape(width, height, radius);
        this.queue_repaint();
    }
});

export function appOf(win) {
    return win ? Shell.WindowTracker.get_default().get_window_app(win) : null;
}

export function sceneName(manager, scene) {
    const main = manager.mainWindow(scene);
    return appOf(main)?.get_name() ?? main?.get_title() ?? 'Escena';
}

// How many windows the thumbnail of @scene turns through.
export function pileSize(manager, scene) {
    return manager.recentWindows(scene).length;
}

export const SceneThumbnail = GObject.registerClass({
    Signals: {
        'drag-begin': {},
        'drag-end': {},
        'hover-changed': {},
    },
}, class SceneThumbnail extends St.Button {
    // @front: the window to show in front (kept across rebuilds of the strip).
    _init(manager, scene, {left = true, scale = 1, front = null} = {}) {
        super._init({
            style_class: 'escenas-thumb',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
        });
        this._manager = manager;
        this._settings = manager.settings;
        this.scene = scene;
        this._delegate = this;
        this._color = sceneColor(scene);
        this._left = left;
        this._scale = scale;
        this._windows = manager.recentWindows(scene);
        this._previewIndex = Math.max(0, this._windows.indexOf(front));
        this._scrollAccum = 0;
        this._lastStep = 0;
        this._resetId = 0;
        this._restackId = 0;
        this._titleIds = [];

        const box = new St.BoxLayout({style_class: 'escenas-thumb-box', x_expand: true});
        box.get_layout_manager().orientation = Clutter.Orientation.VERTICAL;
        this.set_child(box);

        this._stack = new Clutter.Actor({width: Math.round(STACK_WIDTH * scale),
            height: Math.round(STACK_HEIGHT * scale), x_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._stack);
        this._buildPile();

        if (this._windows.length > 1) {
            this._dots = new St.BoxLayout({style_class: 'escenas-stack-dots', x_align: Clutter.ActorAlign.CENTER});
            box.add_child(this._dots);
            this._buildDots();
        }

        const label = new St.BoxLayout({style_class: 'escenas-thumb-label escenas-stack-label', x_expand: true});
        label.get_layout_manager().orientation = Clutter.Orientation.VERTICAL;
        this._name = new St.Label({x_expand: true, x_align: Clutter.ActorAlign.CENTER,
            style_class: 'escenas-thumb-name'});
        this._name.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
        label.add_child(this._name);
        if (this._windows.length > 1) {
            const wheel = this._settings.get_boolean('girar-con-rueda');
            this._hint = new St.Label({style_class: 'escenas-stack-hint', opacity: 0, x_align: Clutter.ActorAlign.CENTER,
                text: wheel ? 'Rueda: siguiente · Clic: abrir' : 'Clic: abrir'});
            this._hint.clutter_text.ellipsize = 3;
            label.add_child(this._hint);
        }
        box.add_child(label);
        this._updateLabel();

        // The label follows the front window's title (Files: the folder it shows).
        for (const win of this._windows)
            this._titleIds.push([win, win.connect('notify::title', () => this._updateLabel())]);

        this.set_pivot_point(0.5, 0.5);
        this.connect('clicked', () => this._open());
        this.connect('notify::hover', () => this._onHover());
        this.connect('scroll-event', (actor, event) => this._onScroll(event));
        this.connect('destroy', () => this._onDestroy());

        this._draggable = DND.makeDraggable(this, {restoreOnSuccess: false});
        this._draggable.connect('drag-begin', () => {
            this._setHover(false);
            this.emit('drag-begin');
        });
        this._draggable.connect('drag-end', () => this.emit('drag-end'));

        // Born turned (the strip was rebuilt while the user was choosing):
        // it still goes back on its own if the pointer is not here.
        if (this._previewIndex)
            this._scheduleReset();
    }

    _onDestroy() {
        for (const [win, id] of this._titleIds)
            win.disconnect(id);
        this._titleIds = [];
        for (const key of ['_resetId', '_restackId']) {
            if (this[key])
                GLib.Source.remove(this[key]);
            this[key] = 0;
        }
    }

    // The window currently in front of the pile.
    get frontWindow() {
        return this._windows[this._previewIndex] ?? this._manager.mainWindow(this.scene);
    }

    _open() {
        this._manager.open(this.scene, this.frontWindow);
    }

    // ---------- the pile ----------

    _buildPile() {
        const s = this._scale;
        this._cardWidth = Math.round(THUMB_WIDTH * s);
        this._cardHeight = Math.round(THUMB_HEIGHT * s);
        // The badges ride on the front place (whatever window is there).
        const f = this._slot(0);
        this._overlay = new St.Widget({layout_manager: new Clutter.BinLayout(),
            x: f.x, y: f.y, width: this._cardWidth, height: this._cardHeight});
        this._stack.add_child(this._overlay);

        this._cards = new Map();
        for (const win of this._windows) {
            const card = this._card(win, this._cardWidth, this._cardHeight);
            card.set_pivot_point(0.5, 0.5);
            this._stack.insert_child_below(card, this._overlay);
            this._cards.set(win, card);
        }
        this._buildBadges();
        this._layoutCards(false);
    }

    // Where the window @slot places behind the front one goes. Slots past the
    // third are not drawn: they wait, invisible, behind the last one.
    _slot(slot) {
        const s = this._scale;
        const visible = Math.max(1, Math.min(this._windows.length, FAN_LAYERS));
        const hidden = slot >= visible;
        const i = Math.min(slot, visible - 1);
        const dir = this._left ? 1 : -1;
        // The whole fan centred across the strip, measured as it is drawn
        // (the cards behind are smaller, so they reach less far inwards):
        // the same room on both sides. The front card at
        // the bottom, on the outer side of the fan.
        const half = THUMB_WIDTH / 2;
        let reach = half;
        for (let k = 1; k < visible; k++)
            reach = Math.max(reach, FAN_X * k + half * (1 - LAYER_SHRINK * k));
        const fanWidth = half + reach;
        const outer = (STACK_WIDTH - fanWidth) / 2 + half;
        const cx = (this._left ? outer : STACK_WIDTH - outer) * s;
        const cy = (STACK_HEIGHT - THUMB_HEIGHT / 2) * s;
        const scale = 1 - LAYER_SHRINK * (hidden ? i + 1 : i);
        return {
            x: Math.round(cx + dir * FAN_X * s * i - this._cardWidth / 2),
            y: Math.round(cy - FAN_Y * s * i - this._cardHeight / 2),
            scale_x: scale,
            scale_y: scale,
            opacity: hidden ? 0 : 255,
            shade: Math.round(255 * LAYER_SHADE * i),
        };
    }

    // Every card to its place for the current front window; @animate slides
    // them there (the depth order changes halfway, so no jump shows).
    _layoutCards(animate) {
        const n = this._windows.length;
        const order = [];
        this._windows.forEach((win, k) => {
            const card = this._cards.get(win);
            const slot = (k - this._previewIndex + n) % n;
            const {shade, ...props} = this._slot(slot);
            order.push([slot, card]);
            card.remove_all_transitions();
            card._shade.remove_all_transitions();
            if (animate && card.has_allocation()) {
                card.ease({...props, duration: ROTATE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                card._shade.ease({opacity: shade, duration: ROTATE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            } else {
                Object.assign(card, props);
                card._shade.opacity = shade;
            }
        });
        this._front = this._cards.get(this.frontWindow) ?? this._front;
        order.sort((a, b) => b[0] - a[0]);
        const restack = () => {
            for (const [, card] of order)
                this._stack.set_child_below_sibling(card, this._overlay);
        };
        if (this._restackId)
            GLib.Source.remove(this._restackId);
        this._restackId = 0;
        if (!animate) {
            restack();
            return;
        }
        this._restackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ROTATE_TIME / 2, () => {
            this._restackId = 0;
            restack();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Turns the pile @step windows (1 = next, -1 = previous), round and round.
    rotate(step) {
        const n = this._windows.length;
        if (n < 2 || !step)
            return;
        this._previewIndex = ((this._previewIndex + step) % n + n) % n;
        this._changed(true);
    }

    _changed(animate) {
        this._layoutCards(animate);
        this._updateDots(animate);
        this._updateLabel();
        this._updateBadge();
        this._updateCloseName();
    }

    _updateCloseName() {
        const win = this.frontWindow;
        this._close.accessible_name = `Cerrar ${appOf(win)?.get_name() ?? win?.get_title() ?? 'ventana'}`;
    }

    // The window's picture filling the card (cropped, top aligned), with round
    // corners and a shade that darkens it when it is behind. It uses the
    // snapshot taken when the scene left the stage, else a live clone, else
    // the app icon.
    _card(win, width, height) {
        const card = new St.Widget({style_class: 'escenas-fan-card', width, height});
        const content = new St.Widget({width, height, clip_to_allocation: true,
            style_class: 'escenas-fan-content'});
        card.add_child(content);

        const snapshot = this._manager.getSnapshot(win);
        const frame = snapshot?.frame ?? win.get_frame_rect();
        const buffer = snapshot?.buffer ?? win.get_buffer_rect();
        const scale = Math.max(width / Math.max(frame.width, 1), height / Math.max(frame.height, 1));
        const actor = win.get_compositor_private();
        let picture = null;
        if (snapshot)
            picture = new Clutter.Actor({content: snapshot.content});
        else if (actor)
            picture = new Clutter.Clone({source: actor});
        if (picture) {
            const left = Math.round((width - frame.width * scale) / 2);
            picture.set_position(left + Math.round((buffer.x - frame.x) * scale), Math.round((buffer.y - frame.y) * scale));
            picture.set_size(Math.round(buffer.width * scale), Math.round(buffer.height * scale));
            content.add_child(picture);
        } else {
            const icon = appOf(win)?.create_icon_texture(48) ??
                new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 40});
            content.add_child(new St.Bin({child: icon, width, height}));
        }
        card._shade = new St.Widget({style_class: 'escenas-fan-shade', width, height, opacity: 0});
        content.add_child(card._shade);
        content.add_effect(new RoundedCorners(width, height, RADIUS));
        return card;
    }

    // Over the front place: the frame, the app icon, the window
    // count and the arrows.
    _buildBadges() {
        const overlay = this._overlay;
        this._frame = new St.Widget({style_class: 'escenas-fan-frame', x_expand: true, y_expand: true});
        overlay.add_child(this._frame);

        this._appBadge = new St.Bin({style_class: 'escenas-badge-app', width: 26, height: 26,
            x_expand: true, y_expand: true,
            x_align: this._left ? Clutter.ActorAlign.START : Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END, translation_x: this._left ? -5 : 5, translation_y: 5});
        overlay.add_child(this._appBadge);
        this._updateBadge();

        const count = this._windows.length;   // dialogs are not counted
        if (count > 1) {
            overlay.add_child(new St.Label({text: `${count}`, style_class: 'escenas-badge-count',
                style: `background-color: ${this._color};`, x_expand: true, y_expand: true,
                x_align: this._left ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.START, translation_x: this._left ? 6 : -6, translation_y: -6}));
        }

        // Closes the window in front: in the middle of its top edge, half over it.
        this._close = new St.Button({style_class: 'escenas-close', can_focus: false,
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.START, translation_y: -11,
            opacity: 0, visible: false});
        this._close.connect('clicked', () => this._manager.closeWindow(this.frontWindow));
        overlay.add_child(this._close);
        this._updateCloseName();

        // On the pile, not on a window: it stays when the pile is turned.
        this._marks = new PrivacyMarks(this._manager, this.scene, this._settings);
        this._marks.connect('changed', () => this._updateLabel());
        overlay.add_child(this._marks);
        overlay.set_child_below_sibling(this._marks, this._close);

        this._arrows = [];
        if (this._windows.length > 1 && this._settings.get_boolean('flechas-pila')) {
            for (const [step, icon, name, align, shift] of [
                [-1, 'go-previous-symbolic', 'Ventana anterior', Clutter.ActorAlign.START, 5],
                [1, 'go-next-symbolic', 'Ventana siguiente', Clutter.ActorAlign.END, -5]]) {
                const arrow = new St.Button({style_class: 'escenas-stack-arrow', accessible_name: name,
                    child: new St.Icon({icon_name: icon, icon_size: 12}), can_focus: false,
                    x_expand: true, y_expand: true, x_align: align, y_align: Clutter.ActorAlign.CENTER,
                    translation_x: shift, opacity: 0, visible: false});
                arrow.connect('clicked', () => this.rotate(step));
                overlay.add_child(arrow);
                this._arrows.push(arrow);
            }
        }
    }

    // The app icon of the window in front.
    _updateBadge() {
        const app = appOf(this.frontWindow) ?? appOf(this._manager.mainWindow(this.scene));
        this._appBadge.child = app ? app.create_icon_texture(19) : null;
        this._appBadge.visible = !!app;
    }

    // ---------- dots and label ----------

    _buildDots() {
        const n = this._windows.length;
        if (n > MAX_DOTS) {
            this._dotsText = new St.Label({style_class: 'escenas-stack-dots-text'});
            this._dots.add_child(this._dotsText);
        } else {
            for (let i = 0; i < n; i++)
                this._dots.add_child(new St.Widget({style_class: 'escenas-stack-dot', width: DOT, opacity: DOT_DIM}));
        }
        this._updateDots(false);
    }

    _updateDots(animate) {
        if (!this._dots)
            return;
        const n = this._windows.length;
        const at = this._previewIndex + 1;
        this._dots.accessible_name = `Ventana ${at} de ${n}`;
        if (this._dotsText) {
            this._dotsText.text = `${at} / ${n}`;
            return;
        }
        this._dots.get_children().forEach((dot, i) => {
            const on = i === this._previewIndex;
            if (on)
                dot.add_style_class_name('active');
            else
                dot.remove_style_class_name('active');
            const target = {width: on ? DOT_ACTIVE : DOT, opacity: on ? 255 : DOT_DIM};
            dot.remove_all_transitions();
            if (animate && dot.has_allocation())
                dot.ease({...target, duration: FADE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                Object.assign(dot, target);
        });
    }

    // "Archivos — Imágenes": the app (scene) name and the front window's title.
    _updateLabel() {
        const win = this.frontWindow;
        const name = appOf(win)?.get_name() ?? sceneName(this._manager, this.scene);
        const title = win?.get_title()?.trim();
        const text = this._marks?.doing ?? (title && title !== name ? `${name} — ${title}` : name);
        this._name.text = text;
        this.accessible_name = text;
    }

    // ---------- wheel and keyboard ----------

    _onScroll(event) {
        if (this._windows.length < 2 || !this._settings.get_boolean('girar-con-rueda'))
            return Clutter.EVENT_PROPAGATE;
        // A wheel that also sends smooth events: count those only once.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        let step = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            step = 1;
            break;
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            step = -1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            this._scrollAccum += dy + dx;
            if (Math.abs(this._scrollAccum) < SCROLL_STEP)
                return Clutter.EVENT_STOP;
            step = Math.sign(this._scrollAccum);
            this._scrollAccum = 0;
            break;
        }
        }
        if (this._settings.get_boolean('invertir-rueda'))
            step = -step;
        const now = GLib.get_monotonic_time() / 1000;
        if (step && now - this._lastStep >= STEP_GAP) {
            this._lastStep = now;
            this.rotate(step);
        }
        return Clutter.EVENT_STOP;
    }

    // ←/→ turn the pile; Enter / Space open it (St.Button's own "clicked").
    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        if (this._windows.length > 1 && (key === Clutter.KEY_Left || key === Clutter.KEY_Right)) {
            this.rotate(key === Clutter.KEY_Left ? -1 : 1);
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }

    // Away from the pile for a moment: back to the most recently used window.
    _scheduleReset() {
        if (this._resetId)
            GLib.Source.remove(this._resetId);
        this._resetId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESET_DELAY, () => {
            this._resetId = 0;
            if (!this.hover && this._previewIndex) {
                this._previewIndex = 0;
                this._changed(true);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- hover ----------

    _onHover() {
        this._setHover(this.hover);
        if (this.hover) {
            if (this._resetId)
                GLib.Source.remove(this._resetId);
            this._resetId = 0;
        } else {
            this._scrollAccum = 0;
            this._scheduleReset();
        }
        this.emit('hover-changed');
    }

    _setHover(on) {
        const target = {translation_x: on ? (this._left ? 6 : -6) : 0, scale_x: on ? 1.03 : 1, scale_y: on ? 1.03 : 1};
        // A thumbnail born under the pointer is hovered before it is laid out:
        // animating it then makes Clutter complain, so just set it.
        const laidOut = this.has_allocation();
        if (laidOut) {
            this.ease({...target, duration: HOVER_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            this.remove_all_transitions();
            Object.assign(this, target);
        }
        for (const actor of [...this._arrows, this._close, this._hint].filter(Boolean))
            this._fade(actor, on, laidOut);
    }

    // Arrows and hint: shown only while the pointer is over the pile. Hidden
    // arrows are not there to catch a click meant for the thumbnail.
    _fade(actor, on, animate) {
        actor.remove_all_transitions();
        if (on)
            actor.show();
        if (!animate) {
            actor.opacity = on ? 255 : 0;
            actor.visible = on || actor === this._hint;
            return;
        }
        actor.ease({opacity: on ? 255 : 0, duration: FADE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: finished => {
                if (finished && !on && actor !== this._hint)
                    actor.hide();
            }});
    }

    // Where the front card is on screen (for the (un)minimize animation).
    get cardRect() {
        const [x, y] = this._overlay.get_transformed_position();
        const [width, height] = this._overlay.get_transformed_size();
        return {x, y, width, height};
    }

    getDragActor() {
        return new Clutter.Clone({source: this._front, width: this._front.width, height: this._front.height, opacity: 230});
    }

    getDragActorSource() {
        return this._front;
    }
});
