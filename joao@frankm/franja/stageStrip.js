// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The side strip: a panel with the wide "+ Nueva escena" button on top
// (newSceneButton.js: it turns a window into a scene of its own: the focused
// one on click, or a window moved or dragged onto it) and the thumbnails of the scenes not on stage. It hides itself when a
// window of the stage covers it (maximized, fullscreen or just overlapping)
// and comes back while the pointer touches that screen edge. Its colors follow
// IslaDock's skin when IslaDock is on.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {STACK_HEIGHT, STRIP_MARGIN, STRIP_WIDTH, THUMB_HEIGHT, THUMB_WIDTH, workArea} from './layout.js';
import {CARD_FIXED_HEIGHT, CARD_PREVIEW_HEIGHT, SceneCard} from './sceneCard.js';
import {PILE_EXTRA_HEIGHT, SceneThumbnail, appOf, pileSize} from './sceneThumbnail.js';
import {NewSceneButton} from './newSceneButton.js';
import {AppsBubble, BUBBLE_INSET, BUBBLE_ROOM} from './appsBubble.js';
import {AppShortcuts} from './appShortcuts.js';
import {StripVolume} from './stripVolume.js';

const ANIMATION_TIME = 200;
const LEAVE_DELAY = 500;
const DRAWER_TIME = 260;        // leaving and coming back around the launcher page
const DRAWER_SHIFT = 14;
// The wheel outside the piles moves the list when there are more scenes than
// fit (Frank 2026-11-03: six apps, five shown, the wheel finds the sixth).
const SCROLL_STEP = 1.0;        // smooth scrolling: accumulated delta per step
const STEP_GAP = 120;           // ms: one wheel gesture moves one scene
const SCROLL_RESET = 1500;      // pointer away this long: back to the most recent
const THUMB_ROW = 150;          // a thumbnail with its label and spacing (estimate before one exists)
// Measures of the strip besides the fans (stylesheet), to fit the thumbnails.
const CHROME_HEIGHT = 26 + 16 + 2 * 10 + 2;   // "Nueva escena" + its gap + padding + border
const LABEL_HEIGHT = 25;                      // name row under a fan
const LIST_SPACING = 10;
const CARD_SPACING = 20;
const ISLA_UUID = 'isla-dock@frankm';
const ISLA_SCHEMA = 'org.gnome.shell.extensions.isla-dock';
// A box with a dashed rounded border (St draws only solid borders). The
// border uses the box's text color from the stylesheet.
function dashedBox(styleClass, text, params = {}) {
    const box = new St.Widget({style_class: styleClass, layout_manager: new Clutter.BinLayout(), ...params});
    const area = new St.DrawingArea({x_expand: true, y_expand: true});
    area.connect('repaint', () => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const c = box.get_theme_node().get_foreground_color();
        const r = Math.min(14, h / 2);
        cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, box.has_style_pseudo_class('drop') ? 0.9 : 0.4);
        cr.setLineWidth(1.5);
        cr.setDash([5, 4], 0);
        const x = 1, y = 1, rw = w - 2, rh = h - 2;
        cr.newSubPath();
        cr.arc(x + rw - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + rw - r, y + rh - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + rh - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
        cr.stroke();
        cr.$dispose();
    });
    box.add_child(area);
    const label = new St.Label({text, x_expand: true, x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.CENTER,
        style_class: `${styleClass.split(" ")[0]}-label`});
    label.clutter_text.line_wrap = true;
    label.clutter_text.ellipsize = 0;
    label.clutter_text.set_line_alignment(2); // Pango.Alignment.CENTER
    box.add_child(label);
    box._area = area;
    box.connect('style-changed', () => area.queue_repaint());
    return box;
}

const MOVE_OPS = ['MOVING', 'MOVING_UNCONSTRAINED', 'KEYBOARD_MOVING']
    .map(name => Meta.GrabOp[name]).filter(op => op !== undefined);

export class StageStrip {
    constructor(manager, settings, view) {
        this._manager = manager;
        this._settings = settings;
        this._hidden = false;     // pushed out by a window
        this._revealed = false;   // brought back by the pointer at the edge
        this._dragging = false;   // a thumbnail is being dragged
        this._movingWindow = null;
        this._dirty = false;
        this._sources = new Set();
        this._ids = [];

        this.actor = new St.BoxLayout({style_class: 'escenas-strip', reactive: true, track_hover: true,
            width: STRIP_WIDTH, visible: false, name: 'escenasStrip', accessible_name: 'Escenas'});
        this.actor.get_layout_manager().orientation = Clutter.Orientation.VERTICAL;

        this._addButton = new NewSceneButton({
            canTake: source => this._windowToTake(source),
            take: win => this._manager.sendToStrip(win),
        });
        this._addButton.connect('clicked', () => this._newSceneFromFocus());
        this.actor.add_child(this._addButton);

        this._list = new St.BoxLayout({style_class: 'escenas-list'});
        this._list.get_layout_manager().orientation = Clutter.Orientation.VERTICAL;
        this.actor.add_child(this._list);

        this.shortcuts = new AppShortcuts(settings);
        this.actor.add_child(this.shortcuts.actor);

        Main.layoutManager.addChrome(this.actor, {affectsInputRegion: true});

        // A 1-px line at the screen edge that brings the strip back.
        this._edge = new St.Widget({reactive: true, width: 1, visible: false, name: 'escenasEdge'});
        Main.layoutManager.addChrome(this._edge, {affectsInputRegion: true});

        this._connect(manager, 'changed', () => {
            this._windowStart = null;   // a scene opened or closed: back to the most recent
            this._queueRebuild();
        });
        this._connect(manager, 'layout-changed', () => this._queueSync());
        this._connect(settings, 'changed', () => this._queueRebuild());
        this._connect(Main.layoutManager, 'monitors-changed', () => this._queueRebuild());
        this._connect(global.display, 'workareas-changed', () => this._queueRebuild());
        this._connect(global.display, 'grab-op-begin', (d, win, op) => this._onGrabBegin(win, op));
        this._connect(global.display, 'grab-op-end', (d, win) => this._onGrabEnd(win));
        this._connect(Main.overview, 'showing', () => this._sync());
        this._connect(Main.overview, 'hidden', () => this._sync());
        this._connect(Main.sessionMode, 'updated', () => this._sync());
        this._connect(Main.extensionManager, 'extension-state-changed', (m, ext) => {
            if (ext.uuid === ISLA_UUID)
                this._watchIsla();
        });
        this._connect(this._edge, 'enter-event', () => this.reveal());
        this._scrollAccum = 0;
        this._lastStep = 0;
        this._connect(this.actor, 'scroll-event', (a, event) => this._onScroll(event));
        this._connect(this.actor, 'notify::hover', () => this._onStripHover());
        this._connect(this.actor, 'notify::height', () => this._once('place', () => this._place()));

        this.volume = new StripVolume(this._addButton);
        this.appsBubble = new AppsBubble(this, settings, view);
        manager.thumbnailRect = (scene, opts) => this._thumbnailRect(scene, opts);
        this._watchIsla();
        this._rebuild();
    }

    destroy() {
        this.appsBubble.destroy();
        this.appsBubble = null;
        for (const [obj, id] of this._ids)
            obj.disconnect(id);
        this._ids = [];
        this._islaSettings?.disconnect(this._islaId);
        this._islaSettings = null;
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        if (this._paintId)
            global.stage.disconnect(this._paintId);
        this._paintId = null;
        for (const e of this._paintQueue ?? []) {
            if (!e.dead)
                e.actor.disconnect(e.destroyId);
        }
        this._paintQueue = [];
        this._movingWindow = null;
        this._endDrag();
        this._manager.thumbnailRect = null;
        this.actor.remove_all_transitions();
        Main.layoutManager.removeChrome(this.actor);
        Main.layoutManager.removeChrome(this._edge);
        this.actor.destroy();
        this._edge.destroy();
        this.actor = this._edge = this.volume = null;
    }

    get thumbnails() {
        return this._list.get_children();
    }

    get _left() {
        return this._settings.get_string('lado') !== 'derecha';
    }

    _connect(obj, signal, fn) {
        this._ids.push([obj, obj.connect(signal, fn)]);
    }

    // ---------- colors ----------

    // IslaDock's own settings (its schema lives in its folder).
    _watchIsla() {
        this._islaSettings?.disconnect(this._islaId);
        this._islaSettings = null;
        const isla = Main.extensionManager.lookup(ISLA_UUID);
        if (isla?.state === 1) {   // ACTIVE
            try {
                const dir = isla.dir.get_child('schemas');
                const source = Gio.SettingsSchemaSource.new_from_directory(dir.get_path(),
                    Gio.SettingsSchemaSource.get_default(), false);
                const schema = source.lookup(ISLA_SCHEMA, false);
                if (schema) {
                    this._islaSettings = new Gio.Settings({settings_schema: schema});
                    this._islaId = this._islaSettings.connect('changed', (s, key) => {
                        if (key === 'isla-piel' || key === 'isla-oscura')
                            this._applyTone();
                    });
                }
            } catch (e) {
                this._islaSettings = null;
            }
        }
        this._applyTone();
    }

    // 'clara' | 'oscura' | 'aurora' (IslaDock's skins) or 'propia' (Escenas' own dark glass).
    _tone() {
        const pref = this._settings.get_string('color-franja');
        if (pref === 'claro')
            return 'clara';
        if (pref === 'oscuro')
            return 'propia';
        const isla = this._islaSettings;
        if (!isla)
            return 'propia';
        if (isla.get_string('isla-piel') === 'aurora')
            return 'aurora';
        return isla.get_boolean('isla-oscura') ? 'oscura' : 'clara';
    }

    _applyTone() {
        if (!this.actor)
            return;
        const over = this.actor.has_style_class_name('encima') ? ' encima' : '';
        this.actor.set_style_class_name(`escenas-strip ${this._tone()} ${this._left ? 'izquierda' : 'derecha'}${over}${this.appsBubble?.enabled ? ' con-burbuja' : ''}`);
    }

    // ---------- building ----------

    _queueRebuild() {
        this._once('rebuild', () => this._rebuild());
    }

    _queueSync() {
        this._once('sync', () => this._sync());
    }

    _once(key, fn) {
        if (this[`_${key}Id`])
            return;
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._sources.delete(id);
            this[`_${key}Id`] = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this[`_${key}Id`] = id;
        this._sources.add(id);
    }

    _rebuild() {
        // Never pull the thumbnail being dragged from under the pointer.
        if (!this.actor)
            return;
        if (this._dragging) {
            this._dirty = true;
            return;
        }
        const old = new Set(this.thumbnails.map(t => t.scene));
        // A pile the user turned keeps its front window (a window closed or a
        // title changed while choosing must not send it back to the first).
        const fronts = new Map(this.thumbnails.filter(t => t._previewIndex).map(t => [t.scene, t.frontWindow]));
        this._list.destroy_all_children();
        // The most recently used, shown in their fixed (numbered) order. All of
        // them (up to the setting) are shown: when they do not fit at full size
        // (IslaDock's top island takes room, small screens) they get smaller.
        this._cards = this._settings.get_string('estilo-miniaturas') === 'tarjeta';
        this._list.set_style_class_name(`escenas-list ${this._cards ? 'tarjetas' : 'abanico'}`);
        const max = this._settings.get_int(this._cards ? 'max-tarjetas' : 'max-miniaturas');
        const inactive = this._manager.getInactiveScenes();
        this._order = inactive;
        this._max = max;
        let shown;
        if (this._windowStart !== null && this._windowStart !== undefined && inactive.length > max) {
            // Scrolled: a run of the list in its fixed order.
            this._windowStart = Math.max(0, Math.min(this._windowStart, inactive.length - max));
            shown = inactive.slice(this._windowStart, this._windowStart + max);
        } else {
            this._windowStart = null;
            shown = inactive.slice().sort((a, b) => b.stamp - a.stamp).slice(0, max);
        }
        this.shortcuts.sync(workArea()?.height ?? 0);
        const scale = this._thumbScale(shown);
        for (const scene of inactive.filter(s => shown.includes(s))) {
            const Kind = this._cards ? SceneCard : SceneThumbnail;
            const thumb = new Kind(this._manager, scene, {left: this._left, scale, front: fronts.get(scene)});
            thumb.connect('drag-begin', () => this._beginDrag());
            thumb.connect('drag-end', () => this._endDrag());
            this._list.add_child(thumb);
            if (!old.has(scene)) {
                thumb.opacity = 0;
                this._easeLater(thumb, {opacity: 255, duration: ANIMATION_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        }
        this._list.visible = this.thumbnails.length > 0;
        this._applyTone();
        this._place();
        this._sync();
    }

    // ---------- the wheel: scenes that do not fit ----------

    // The volume lives in the strip: if it is away (the launcher button came out alone), it comes back.
    wheelVolume(event) {
        if (this._hidden)
            this.reveal();
        return this.volume.onWheel(event);
    }

    // Over a pile with several windows the wheel turns the pile (the
    // thumbnail stops the event); anywhere else on the strip it moves the
    // list one scene at a time, when there are more scenes than shown, and
    // otherwise the volume. The launcher button always does the volume.
    _onScroll(event) {
        const order = this._order ?? [];
        if (this._dragging)
            return Clutter.EVENT_PROPAGATE;
        if (order.length <= (this._max ?? 0))
            return this.wheelVolume(event);
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
            this.scrollList(step);
        }
        return Clutter.EVENT_STOP;
    }

    // Moves the shown run of scenes by @step (+1 = further down the list).
    scrollList(step) {
        const order = this._order ?? [];
        const max = this._max ?? 0;
        if (order.length <= max)
            return false;
        let start = this._windowStart;
        if (start === null || start === undefined) {
            // From the most recent ones: the run that holds most of them.
            const shown = new Set(this.thumbnails.map(t => t.scene));
            start = 0;
            let best = -1;
            for (let i = 0; i <= order.length - max; i++) {
                const hits = order.slice(i, i + max).filter(sc => shown.has(sc)).length;
                if (hits > best) {
                    best = hits;
                    start = i;
                }
            }
            const run = order.slice(start, start + max);
            // Already showing exactly what the scroll would show: move on.
            if (run.some(sc => !shown.has(sc))) {
                this._windowStart = start;
                this._rebuild();
                return true;
            }
        }
        const next = Math.max(0, Math.min(start + step, order.length - max));
        if (next === this._windowStart)
            return false;
        this._windowStart = next;
        this._rebuild();
        return true;
    }

    _onStripHover() {
        if (this._scrollResetId) {
            GLib.source_remove(this._scrollResetId);
            this._sources.delete(this._scrollResetId);
            this._scrollResetId = 0;
        }
        if (this.actor.hover || this._windowStart === null || this._windowStart === undefined)
            return;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_RESET, () => {
            this._sources.delete(id);
            this._scrollResetId = 0;
            if (!this.actor.hover && !this._dragging) {
                this._windowStart = null;
                this._rebuild();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._scrollResetId = id;
        this._sources.add(id);
    }

    // 1 = full size; less when the @scenes' thumbnails would not fit in the work area.
    _thumbScale(scenes) {
        const area = workArea();
        const count = scenes.length;
        if (!area || !count)
            return 1;
        // Fans with several windows also have the dots and the hint under them.
        const extra = this._cards ? 0
            : scenes.filter(s => pileSize(this._manager, s) > 1).length * PILE_EXTRA_HEIGHT;
        const [perItem, scalable, spacing] = this._cards
            ? [CARD_FIXED_HEIGHT, CARD_PREVIEW_HEIGHT, CARD_SPACING]
            : [LABEL_HEIGHT, STACK_HEIGHT, LIST_SPACING];
        const bubble = this.appsBubble?.enabled ? BUBBLE_INSET : 0;
        const fixed = CHROME_HEIGHT + bubble + this.shortcuts.height + count * perItem + (count - 1) * spacing + extra;
        const room = area.height - STRIP_MARGIN - this._roomBelow - fixed;
        return Math.max(0.4, Math.min(1, room / (count * scalable)));
    }

    // Animating an actor before it is laid out makes Clutter complain ("needs an
    // allocation"): start once the stage has been painted with it in place.
    // @valid says whether the animation is still wanted.
    _easeLater(actor, params, valid = () => true) {
        this._afterPaint(actor, () => valid() && actor.ease(params));
    }

    // Runs @fn now if @actor is laid out, else after the next stage paint.
    _afterPaint(actor, fn) {
        if (actor.has_allocation()) {
            fn();
            return;
        }
        // An actor destroyed while waiting (the strip was rebuilt) drops out:
        // touching it afterwards is an error.
        const entry = {actor, fn, dead: false};
        entry.destroyId = actor.connect('destroy', () => {
            entry.dead = true;
        });
        this._paintQueue ??= [];
        this._paintQueue.push(entry);
        this._paintId ??= global.stage.connect('after-paint', () => {
            global.stage.disconnect(this._paintId);
            this._paintId = null;
            const queue = this._paintQueue;
            this._paintQueue = [];
            for (const e of queue) {
                if (e.dead)
                    continue;
                e.actor.disconnect(e.destroyId);
                if (!this.actor || !e.actor.get_stage())
                    continue;
                if (e.actor.has_allocation())
                    e.fn();
                else
                    this._afterPaint(e.actor, e.fn);
            }
        });
    }

    // Where the strip sits when shown (no animation offset): 16 px from the
    // edge, centred vertically in the work area (Frank: as much room above as below).
    _rect() {
        const area = workArea();
        if (!area)
            return null;
        const [, height] = this.actor.get_preferred_height(STRIP_WIDTH);
        const x = this._left ? area.x + STRIP_MARGIN : area.x + area.width - STRIP_WIDTH - STRIP_MARGIN;
        // Too tall to be centered with the bubble under it: it moves up instead.
        const highest = area.height - height - this._roomBelow;
        const y = area.y + Math.max(STRIP_MARGIN, Math.min(highest, Math.round((area.height - height) / 2)));
        return {x, y, width: STRIP_WIDTH, height};
    }

    get _roomBelow() {
        return this.appsBubble?.enabled ? BUBBLE_ROOM : STRIP_MARGIN;
    }

    restingRect() {
        return this._rect();
    }

    // Sliding away or already gone: a window covers its place, or the page is open.
    get isAway() {
        return !!this._hidden;
    }

    // The launcher page is opening or closing: the strip steps aside with a short move.
    setDrawerOpen(open) {
        this._drawerOpen = open;
        if (open)
            this.volume.hideNow();
        this._drawerMove = true;
        this._sync();
        this._drawerMove = false;
    }

    _place() {
        const rect = this._rect();
        if (!rect)
            return;
        this.actor.set_position(rect.x, rect.y);
        const area = workArea();
        this._edge.set_position(this._left ? area.x : area.x + area.width - 1, area.y);
        this._edge.height = area.height;
    }

    // Where @scene's thumbnail is, or (leaving) will be once the scene on stage
    // changes: the (un)minimize animations go there.
    _thumbnailRect(scene, {leaving}) {
        const rect = this._rect();
        if (!rect)
            return null;
        const shown = this.actor.visible && !this._hidden;
        if (!leaving) {
            const thumb = this.thumbnails.find(t => t.scene === scene);
            if (thumb && shown)
                return thumb.cardRect;
        }
        const scenes = this._manager.getInactiveScenes();
        const index = Math.max(0, scenes.indexOf(scene));
        const first = this.thumbnails[0];
        const pitch = first ? first.height + this._list.get_theme_node().get_length('spacing') : THUMB_ROW;
        const top = first ? first.cardRect.y : rect.y + 60;
        const x = shown ? rect.x + (STRIP_WIDTH - THUMB_WIDTH) / 2
            : this._left ? rect.x - STRIP_WIDTH : rect.x + STRIP_WIDTH;
        return {x, y: top + index * pitch, width: THUMB_WIDTH, height: THUMB_HEIGHT};
    }

    // ---------- showing and hiding ----------

    // Is a window of the stage covering the strip's place?
    _covered() {
        if (!this._settings.get_boolean('ocultar-automatico'))
            return false;
        const rect = this._rect();
        const scene = this._manager.activeScene;
        if (!rect || !scene)
            return false;
        return scene.windows.some(win => {
            if (win.minimized || !win.showing_on_its_workspace?.())
                return false;
            if (win.fullscreen)
                return true;
            const f = win.get_frame_rect();
            return f.x < rect.x + rect.width && f.x + f.width > rect.x &&
                f.y < rect.y + rect.height && f.y + f.height > rect.y;
        });
    }

    _sync() {
        if (!this.actor)
            return;
        const wanted = !Main.overview.visible && !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter;
        const covered = this._covered();
        if (!covered)
            this._revealed = false;
        const show = wanted && !this._drawerOpen && (!covered || this._revealed || this._dragging || !!this._movingWindow);
        // Over a window (brought back by the edge) the see-through panel turns denser.
        if (covered)
            this.actor.add_style_class_name('encima');
        else
            this.actor.remove_style_class_name('encima');
        this._edge.visible = wanted && covered && !show && !this._drawerOpen;
        this._animate(show, wanted);
    }

    _animate(show, wanted) {
        const away = (this._left ? -1 : 1) * (this._drawerMove ? DRAWER_SHIFT : STRIP_WIDTH + 2 * STRIP_MARGIN);
        const duration = this._drawerMove ? DRAWER_TIME : ANIMATION_TIME;
        if (show) {
            if (this.actor.visible && !this._hidden)
                return;
            this._hidden = false;
            if (!this.actor.visible) {
                this.actor.show();
                if (!this._wasHidden) {
                    // Appearing: no slide.
                    this.actor.translation_x = 0;
                    this.actor.opacity = 255;
                    return;
                }
                this.actor.translation_x = away;
                this.actor.opacity = 0;
            }
            this._wasHidden = false;
            this._easeLater(this.actor, {translation_x: 0, opacity: 255, duration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => this._refreshInputRegion()},
            () => !this._hidden);
            return;
        }
        if (!wanted) {
            // Overview, lock screen: just go.
            this._hidden = false;
            this._wasHidden = false;
            this.actor.remove_all_transitions();
            this.actor.hide();
            return;
        }
        if (this._hidden)
            return;
        this._hidden = true;
        this._wasHidden = true;
        this.actor.ease({translation_x: away, opacity: 0, duration,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: finished => {
                if (finished && this._hidden)
                    this.actor.hide();
            }});
    }

    // On X11 the shell takes clicks only inside its input region, computed from
    // where the strip *is* when its size or visibility changes. Shown sliding in
    // from outside the screen, that is off screen: clicks fell through to the
    // window behind (Frank: Firefox with a video). Recompute after the slide.
    _refreshInputRegion() {
        Main.layoutManager._queueUpdateRegions?.();
    }

    // Brought back by the screen edge, the top bar chip or a saved scene.
    reveal() {
        this._revealed = true;
        this._sync();
        this._watchPointer();
    }

    // While brought back by the edge: hide again once the pointer has been away
    // from the band between the edge and the strip for a moment.
    _watchPointer() {
        if (this._leaveId)
            return;
        let away = 0;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            const rect = this._rect();
            const area = workArea();
            if (!this._revealed || !rect || !area) {
                this._sources.delete(id);
                this._leaveId = 0;
                return GLib.SOURCE_REMOVE;
            }
            const [x, y] = global.get_pointer();
            const left = this._left ? area.x : rect.x - STRIP_MARGIN;
            const right = this._left ? rect.x + rect.width + STRIP_MARGIN : area.x + area.width;
            const inside = x >= left && x < right && y >= area.y && y < area.y + area.height;
            away = inside || this._dragging || this.volume.dragging ? 0 : away + 100;
            if (away < LEAVE_DELAY)
                return GLib.SOURCE_CONTINUE;
            this._sources.delete(id);
            this._leaveId = 0;
            this._revealed = false;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
        this._leaveId = id;
        this._sources.add(id);
    }

    // ---------- a window moved onto "Nueva escena" ----------

    _onGrabBegin(win, op) {
        if (!win || !MOVE_OPS.includes(op) || !this._manager.sceneOf(win))
            return;
        this._movingWindow = win;
        this._sync();
        if (this._grabPollId)
            return;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._movingWindow) {
                this._sources.delete(id);
                this._grabPollId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._highlightDrop(this._pointerOnDropZone());
            return GLib.SOURCE_CONTINUE;
        });
        this._grabPollId = id;
        this._sources.add(id);
    }

    _onGrabEnd(win) {
        if (!this._movingWindow || win !== this._movingWindow)
            return;
        const drop = this._pointerOnDropZone();
        this._movingWindow = null;
        this._highlightDrop(false);
        if (drop)
            this._manager.sendToStrip(win);
        this._queueSync();
    }

    _pointerOnDropZone() {
        if (!this.actor?.visible || this._hidden)
            return false;
        const [x, y] = global.get_pointer();
        return this._addButton.containsPoint(x, y);
    }

    _highlightDrop(on) {
        this._addButton.setDrop(on);
    }

    // What a DND drag over "Nueva escena" would make a scene of: a window
    // (anything carrying metaWindow) of ours, or the front window of a
    // thumbnail whose scene mixes apps (a pile of one app's windows would
    // only join itself again: those stay together, Frank 2026-11-02).
    _windowToTake(source) {
        const m = this._manager;
        if (source?.metaWindow)
            return m.sceneOf(source.metaWindow) ? source.metaWindow : null;
        const scene = source?.scene;
        if (!scene)
            return null;
        const own = scene.windows.filter(w => !w.get_transient_for());
        if (own.length < 2 || own.every(w => appOf(w) === appOf(own[0])))
            return null;
        return source.frontWindow ?? m.mainWindow(scene);
    }

    // "+" clicked: the focused window of the stage becomes a scene of its own.
    _newSceneFromFocus() {
        const scene = this._manager.activeScene;
        if (!scene)
            return;
        const focus = global.display.focus_window;
        const win = scene.windows.includes(focus) ? focus : this._manager.mainWindow(scene);
        if (win)
            this._manager.sendToStrip(win);
    }

    // ---------- a thumbnail dragged onto the stage: join it ----------

    _beginDrag() {
        this._dragging = true;
        const area = workArea();
        const rect = this._rect();
        if (!area || !rect)
            return;
        // Everything on the primary monitor except the strip itself.
        const x = this._left ? rect.x + rect.width + STRIP_MARGIN : area.x;
        const width = this._left ? area.x + area.width - x : rect.x - STRIP_MARGIN - area.x;
        this._mergeZone = dashedBox(`escenas-merge-zone ${this._tone()}`, 'Suelta aquí para unirla a la escena actual',
            {reactive: true, x: x + STRIP_MARGIN, y: area.y + STRIP_MARGIN, width: width - 2 * STRIP_MARGIN,
                height: area.height - 2 * STRIP_MARGIN, opacity: 0});
        this._mergeZone._delegate = {
            handleDragOver: source => {
                this._mergeZone?.add_style_pseudo_class('drop');
                return source?.scene ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.NO_DROP;
            },
            acceptDrop: source => {
                if (!source?.scene)
                    return false;
                this._manager.merge(source.scene);
                return true;
            },
        };
        this._dragMonitor = {
            dragMotion: event => {
                if (event.targetActor !== this._mergeZone && !this._mergeZone?.contains(event.targetActor))
                    this._mergeZone?.remove_style_pseudo_class('drop');
                return DND.DragMotionResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);
        Main.uiGroup.add_child(this._mergeZone);
        this._mergeZone.ease({opacity: 255, duration: ANIMATION_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _endDrag() {
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._mergeZone?.destroy();
        this._mergeZone = null;
        if (!this._dragging)
            return;
        this._dragging = false;
        if (this._dirty) {
            this._dirty = false;
            this._queueRebuild();
        } else if (this.actor) {
            this._queueSync();
        }
    }
}
