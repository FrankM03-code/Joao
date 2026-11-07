// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The scenes card turns into the ring's menu (docs/menu-cortina-spec.md): the scenes sink towards
// the ring and fade, the card takes the blue glass, and the menu comes down from its top edge
// like a curtain. A tool takes the menu's place with a fade while the card grows upwards and
// towards the middle of the screen (docs/herramientas-ampliadas-spec.md), its bottom edge staying
// put. Nothing bounces (Frank 2026-11-07).
//
// The card is drawn in the layer that holds the input while the menu is open, exactly over the
// strip, whose own background fades out meanwhile: one card changing, nothing on top of another.
// Without the strip (scenes off) a card of the same width opens in the bottom-left corner.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {appsBubble, escenasStrip} from '../escenas/escenasLink.js';
import {STRIP_WIDTH} from '../franja/layout.js';
import {animations, scaleFactor} from './popup.js';

const SINK = 70;
const SINK_SCALE = 0.94;
const SINK_TIME = 500;
const SINK_FADE = 350;
const RISE_TIME = 400;
const CURTAIN_DOWN = 550;
const CURTAIN_UP = 300;
const GROW = 350;
const RESIZE = 450;
const SWAP_OUT = 250;
const SWAP_IN = 250;
const PADDING = 10;
const BUBBLE_INSET = 42;    // stylesheet: .escenas-strip.con-burbuja, the bubble's half below
const CORNER = 16;
const QUINT = Clutter.AnimationMode.EASE_OUT_QUINT;

const css = c => `rgba(${c.red}, ${c.green}, ${c.blue}, ${(c.alpha / 255).toFixed(3)})`;

export class Curtain {
    constructor(layer) {
        this._layer = layer;
        this._page = null;
        this._strip = escenasStrip()?.actor?.visible && !escenasStrip().isAway ? escenasStrip() : null;
        this._bubble = appsBubble();

        this.card = new St.Widget({style_class: 'joao-curtain', layout_manager: new Clutter.BinLayout(),
            reactive: true, clip_to_allocation: true});
        this._reveal = new St.Widget({clip_to_allocation: true, x_expand: true, y_expand: false,
            y_align: Clutter.ActorAlign.START, height: 0});
        this._inner = new St.BoxLayout({style_class: 'joao-curtain-inner', orientation: Clutter.Orientation.VERTICAL});
        if (this._bubble?.onScreen)
            this._inner.add_style_class_name('con-burbuja');
        this._reveal.add_child(this._inner);
        this.card.add_child(this._reveal);
        layer.add_child(this.card);

        const rect = this._base();
        this._rect = rect;
        this.card.set_position(rect.x, rect.y);
        this.card.set_size(rect.width, rect.height);
        this._inner.set_size(rect.width, rect.height);
        // The ring stays above the card, as it is above the strip.
        if (this._bubble?.actor?.get_parent() === Main.uiGroup)
            Main.uiGroup.set_child_above_sibling(this._bubble.actor, layer);
    }

    // Where the card starts: the strip itself, or its size in the corner.
    _base() {
        const strip = this._strip;
        if (strip) {
            const [x, y] = strip.actor.get_transformed_position();
            const [width, height] = strip.actor.get_transformed_size();
            return {x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height),
                monitor: Main.layoutManager.findMonitorForActor(strip.actor)};
        }
        const scale = scaleFactor();
        const monitor = Main.layoutManager.primaryMonitor;
        const resting = escenasStrip()?.restingRect?.();
        if (resting)
            return {...resting, monitor};
        const width = STRIP_WIDTH * scale;
        return {x: monitor.x + CORNER * scale, y: monitor.y + monitor.height - CORNER * scale, width, height: 0, monitor};
    }

    get page() {
        return this._page;
    }

    get isOpen() {
        return !!this._page;
    }

    // Towards the middle of the screen: right when the strip is on the left half.
    get _growsRight() {
        const m = this._rect.monitor;
        return this._rect.x + this._rect.width / 2 < m.x + m.width / 2;
    }

    // The card for this page: a tool asks for its size (page.cardSize, logical px), the menu and
    // the timer take what they need. It never covers less than the strip, keeps its bottom edge
    // and the edge next to the screen's side, and stays on the screen (the page scrolls then).
    _target(page) {
        const scale = scaleFactor();
        const r = this._rect;
        const m = r.monitor;
        const bottom = r.y + r.height;
        let width = r.width;
        let height;
        if (page.cardSize) {
            width = Math.max(r.width, page.cardSize.width * scale);
            height = Math.max(r.height, page.cardSize.height * scale);
        } else {
            const inset = (this._inner.has_style_class_name('con-burbuja') ? BUBBLE_INSET : PADDING) * scale;
            const [, natural] = page.get_preferred_height(width - 2 * PADDING * scale);
            height = Math.max(r.height, Math.ceil(natural + PADDING * scale + inset));
        }
        width = Math.min(width, m.width - 2 * CORNER * scale);
        height = Math.min(height, bottom - m.y - CORNER * scale);
        const x = this._growsRight ? r.x : r.x + r.width - width;
        return {x: Math.round(x), y: Math.round(bottom - height), width: Math.round(width), height: Math.round(height)};
    }

    _sizeInner(target) {
        this._inner.set_size(target.width, target.height);
    }

    // The first page: the scenes sink, the card turns blue, the curtain comes down. The card is at
    // its size at once: nothing jumps, only the curtain moves.
    open(page) {
        this._page = page;
        const target = this._target(page);
        this._inner.add_child(page);
        this._sizeInner(target);
        this.card.set({x: target.x, y: target.y, width: target.width, height: target.height});
        const looks = this._strip ? this._stripLooks() : 'background-color: transparent; border-color: transparent;';
        this.card.style = looks;
        this._sinkStrip(true);
        if (!animations()) {
            this.card.style = null;
            this._reveal.height = -1;
            page.enter?.(false);
            return;
        }
        // Next frame: the stylesheet's transition fades the strip's colours into the glass.
        this._later(() => {
            this.card.style = null;
        });
        this._reveal.ease({height: target.height, duration: CURTAIN_DOWN, mode: QUINT,
            onStopped: done => done && this._page === page && (this._reveal.height = -1)});
        page.enter?.(true);
        this._watch(page);
    }

    // Another page: the card takes the new size (upwards and towards the middle), the old content
    // fades and the new one comes in a little later, once the card has mostly changed.
    swap(page) {
        const old = this._page;
        this._page = page;
        old?.disconnectObject?.(this);
        const target = this._target(page);
        const show = () => {
            old?.destroy();
            this._sizeInner(target);
            this._inner.add_child(page);
            this._reveal.remove_transition('height');
            this._reveal.height = -1;
            if (!animations()) {
                page.enter?.(false);
                return;
            }
            page.opacity = 0;
            page.ease({opacity: 255, duration: SWAP_IN, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            page.enter?.(true);
            this._watch(page);
        };
        if (!animations()) {
            this.card.set({x: target.x, y: target.y, width: target.width, height: target.height});
            show();
            return;
        }
        this.card.ease({x: target.x, y: target.y, width: target.width, height: target.height, duration: RESIZE, mode: QUINT});
        if (!old) {
            show();
            return;
        }
        old.reactive = false;
        old.ease({opacity: 0, duration: SWAP_OUT, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._page === page && show()});
    }

    // A page that changes its height (the menu's timer line): the card follows, upwards.
    _watch(page) {
        if (page.cardSize)
            return;
        page.connectObject('notify::height', () => {
            if (this._page !== page || this._closing)
                return;
            const target = this._target(page);
            if (Math.abs(target.height - this.card.height) < 1)
                return;
            this._sizeInner(target);
            this.card.ease({y: target.y, height: target.height, duration: animations() ? GROW : 0, mode: QUINT});
        }, this);
    }

    // Back to the scenes: everything the other way, faster.
    close(done) {
        this._closing = true;
        const page = this._page;
        this._page = null;
        page?.disconnectObject?.(this);
        if (page)
            page.reactive = false;
        this._sinkStrip(false);
        if (!animations()) {
            done();
            return;
        }
        page?.leave?.();
        this._reveal.remove_transition('height');
        this._reveal.height = this._reveal.get_height();
        this._reveal.ease({height: 0, duration: CURTAIN_UP, mode: Clutter.AnimationMode.EASE_IN_QUAD});
        this.card.ease({x: this._rect.x, y: this._rect.y, width: this._rect.width, height: Math.max(this._rect.height, 1),
            duration: RESIZE, mode: QUINT});
        // The card takes the strip's colours again (the stylesheet fades them); without a strip it fades out.
        this.card.style = this._strip ? this._stripLooks() : 'background-color: transparent; border-color: transparent;';
        if (!this._strip)
            this.card.ease({opacity: 0, duration: RISE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._doneId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESIZE, () => {
            this._doneId = 0;
            done();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The strip's colours now (clear or dark glass, over a window or not).
    _stripLooks() {
        const node = this._strip.actor.get_theme_node();
        return `background-color: ${css(node.get_background_color())}; border-color: ${css(node.get_border_color(St.Side.TOP))};`;
    }

    // The strip's content sinks towards the ring and fades; its background lets the card show.
    _sinkStrip(sink) {
        const strip = escenasStrip();
        if (!strip?.actor)
            return;
        const scale = scaleFactor();
        if (sink)
            strip.actor.add_style_class_name('curtain');
        for (const child of strip.actor.get_children()) {
            child.set_pivot_point(0.5, 0.5);
            child.remove_transition('translation-y');
            child.remove_transition('scale-x');
            child.remove_transition('scale-y');
            child.remove_transition('opacity');
            if (!animations() || !child.has_allocation()) {
                child.set(sink ? {translation_y: SINK * scale, scale_x: SINK_SCALE, scale_y: SINK_SCALE, opacity: 0}
                    : {translation_y: 0, scale_x: 1, scale_y: 1, opacity: 255});
                continue;
            }
            if (sink) {
                child.ease({translation_y: SINK * scale, scale_x: SINK_SCALE, scale_y: SINK_SCALE, duration: SINK_TIME,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC});
                child.ease({opacity: 0, duration: SINK_FADE, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            } else {
                child.ease({translation_y: 0, scale_x: 1, scale_y: 1, opacity: 255, duration: RISE_TIME, mode: QUINT});
            }
        }
    }

    // The strip's own background again, once the card has taken its colours (on the way out).
    restoreStrip() {
        escenasStrip()?.actor?.remove_style_class_name('curtain');
    }

    destroy() {
        if (this._doneId)
            GLib.source_remove(this._doneId);
        this._doneId = 0;
        this._page?.disconnectObject?.(this);
        if (this._page)
            this._sinkStrip(false);
        this.restoreStrip();
    }

    _later(fn) {
        const id = global.stage.connect('after-paint', () => {
            global.stage.disconnect(id);
            if (this.card.get_stage())
                fn();
        });
        global.stage.queue_redraw();
    }
}
