// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// "Tarjeta" style: each scene is a flat glass card
// with a header (app icon, scene name, window count) and a preview of the
// window that last had the focus, filling the box without its title bar; with
// more windows, up to two more peek out behind it (Frank: "one behind the other").
// A dot marks activity (attention request or notification). Click = put the
// scene on stage; drag it to the middle of the screen = join it to the stage.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import {sceneColor} from './layout.js';
import {PrivacyMarks} from './privacyBadges.js';
import {RoundedCorners, appOf, sceneName} from './sceneThumbnail.js';

export const CARD_WIDTH = 200;
const PADDING = 10;
const PREVIEW_HEIGHT = 104;
const PREVIEW_RADIUS = 8;
const HEADERBAR = 46;        // what a client-side title bar takes (GTK/libadwaita)
const HOVER_TIME = 160;
const SHIFT = 4;             // towards the middle of the screen on hover
const LAYERS = 3;            // windows shown one behind the other
const PEEK = 9;              // each one behind shows this much above…
const INSET = 9;             // …and is this much narrower on each side
const DARKEN = -0.28;
const CLOSE_SIZE = 22;       // the close button, with its border (stylesheet)
// Height besides the preview: padding, header (20) and its gap, the layers
// peeking behind (room always kept, so all cards match), border.
export const CARD_FIXED_HEIGHT = 2 * PADDING + 20 + 10 + (LAYERS - 1) * PEEK + 2;
export const CARD_PREVIEW_HEIGHT = PREVIEW_HEIGHT;

// The window without its title bar: server-side frame off, and a client-side
// one (no server decorations) cut when the window is tall enough to spare it.
function contentRect(win, frame) {
    const csd = !win.decorated;
    let rect = frame;
    if (!csd) {
        try {
            rect = win.frame_rect_to_client_rect(frame);
        } catch (e) {
            rect = frame;
        }
    }
    let {x, y, width, height} = rect;
    if (csd && height > HEADERBAR * 3) {
        y += HEADERBAR;
        height -= HEADERBAR;
    }
    return {x, y, width, height};
}

export const SceneCard = GObject.registerClass({
    Signals: {
        'drag-begin': {},
        'drag-end': {},
        'hover-changed': {},
    },
}, class SceneCard extends St.Button {
    _init(manager, scene, {left = true, scale = 1} = {}) {
        super._init({
            style_class: 'escenas-card',
            reactive: true,
            can_focus: true,
            track_hover: true,
            width: CARD_WIDTH,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._manager = manager;
        this.scene = scene;
        this._delegate = this;
        this._color = sceneColor(scene);
        this._left = left;

        // The box, with the activity dot over its top-right corner.
        const layer = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        this.set_child(layer);
        const box = new St.BoxLayout({style_class: 'escenas-card-box', x_expand: true});
        box.get_layout_manager().orientation = Clutter.Orientation.VERTICAL;
        layer.add_child(box);

        const main = manager.mainWindow(scene);
        const app = appOf(main);
        const name = sceneName(manager, scene);
        const header = new St.BoxLayout({style_class: 'escenas-card-header', x_expand: true});
        if (app) {
            header.add_child(new St.Bin({style_class: 'escenas-card-icon', child: app.create_icon_texture(20),
                y_align: Clutter.ActorAlign.CENTER}));
        } else {
            header.add_child(new St.Label({style_class: 'escenas-card-icon escenas-card-initial',
                text: name.slice(0, 1).toUpperCase(), style: `background-color: ${this._color};`,
                y_align: Clutter.ActorAlign.CENTER}));
        }
        const label = new St.Label({text: name, style_class: 'escenas-card-name', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._nameLabel = label;
        label.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
        header.add_child(label);
        // Dialogs are not counted nor shown: they go with their window.
        const own = manager.recentWindows(scene);
        header.add_child(new St.Label({text: `${own.length}`, style_class: 'escenas-card-count',
            y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(header);

        const width = CARD_WIDTH - 2 * PADDING - 2;
        const height = Math.max(48, Math.round(PREVIEW_HEIGHT * scale));
        // One window behind the other (up to 3): the main one in front, the
        // others peeking above it, narrower and darker.
        const stack = new Clutter.Actor({width, height: height + (LAYERS - 1) * PEEK});
        const others = own.filter(w => w !== main).slice(0, LAYERS - 1);
        others.reverse().forEach((win, k) => {
            const depth = others.length - k;   // 2 = furthest back
            const w = width - 2 * INSET * depth;
            const layer = this._layer(win, w, height);
            layer.set_position(INSET * depth, (LAYERS - 1 - depth) * PEEK);
            const dim = new Clutter.BrightnessContrastEffect();
            dim.set_brightness(DARKEN * depth);
            layer.add_effect(dim);
            stack.add_child(layer);
        });
        this._preview = this._layer(main, width, height);
        this._preview.set_position(0, (LAYERS - 1) * PEEK);
        stack.add_child(this._preview);
        this._marks = new PrivacyMarks(manager, scene, manager.settings);
        this._marks.set_position(this._preview.x, this._preview.y);
        this._marks.set_size(width, height);
        this._marks.connect('changed', () => this._updateName());
        stack.add_child(this._marks);
        // Closes the window in front: in the middle of its top edge, half over it;
        // only there while the pointer is over the card.
        this._close = new St.Button({style_class: 'escenas-close', can_focus: false,
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
            accessible_name: `Cerrar ${app?.get_name() ?? main?.get_title() ?? 'ventana'}`,
            x: Math.round((width - CLOSE_SIZE) / 2), y: (LAYERS - 1) * PEEK - CLOSE_SIZE / 2, opacity: 0, visible: false});
        this._close.connect('clicked', () => this._manager.closeWindow(main));
        stack.add_child(this._close);
        box.add_child(stack);

        if (scene.activity) {
            layer.add_child(new St.Widget({style_class: 'escenas-activity-dot', style: `background-color: ${this._color};`,
                x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START,
                translation_x: PADDING + 4, translation_y: -PADDING - 4}));
        }
        this._plainName = name;
        this._updateName();
        this.set_pivot_point(0.5, 0.5);

        this.connect('clicked', () => this._manager.activate(this.scene));
        this.connect('notify::hover', () => {
            this._setHover(this.hover);
            this.emit('hover-changed');
        });
        // Pressed: a little smaller while the button is down.
        this.connect('notify::pressed', () => {
            if (this.has_allocation())
                this.ease({scale_x: this.pressed ? 0.97 : 1, scale_y: this.pressed ? 0.97 : 1, duration: 90,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });

        this._draggable = DND.makeDraggable(this, {restoreOnSuccess: false});
        this._draggable.connect('drag-begin', () => {
            this._setHover(false);
            this.emit('drag-begin');
        });
        this._draggable.connect('drag-end', () => this.emit('drag-end'));
    }

    _updateName() {
        const text = this._marks.doing ?? this._plainName;
        this._nameLabel.text = text;
        this.accessible_name = text;
    }

    // One window's preview box (rounded), filled with its picture.
    _layer(win, width, height) {
        const box = new St.Widget({style_class: 'escenas-card-preview', width, height, clip_to_allocation: true});
        if (win)
            this._fill(box, win, width, height);
        box.add_effect(new RoundedCorners(width, height, PREVIEW_RADIUS));
        return box;
    }

    // The window's picture covering the preview box (cropped, keeping its
    // proportions), from the snapshot taken when it left the stage, else a
    // live clone, else the app icon.
    _fill(target, win, width, height) {
        const snapshot = this._manager.getSnapshot(win);
        const frame = snapshot?.frame ?? win.get_frame_rect();
        const buffer = snapshot?.buffer ?? win.get_buffer_rect();
        const crop = contentRect(win, frame);
        const sc = Math.max(width / Math.max(crop.width, 1), height / Math.max(crop.height, 1));
        const actor = win.get_compositor_private();
        let picture = null;
        if (snapshot)
            picture = new Clutter.Actor({content: snapshot.content});
        else if (actor)
            picture = new Clutter.Clone({source: actor});
        if (!picture) {
            const icon = appOf(win)?.create_icon_texture(48);
            if (icon)
                target.add_child(new St.Bin({child: icon, width, height}));
            return;
        }
        // Centred across, top aligned (the top of a window says the most).
        const left = Math.round((width - crop.width * sc) / 2);
        picture.set_position(left + Math.round((buffer.x - crop.x) * sc), Math.round((buffer.y - crop.y) * sc));
        picture.set_size(Math.round(buffer.width * sc), Math.round(buffer.height * sc));
        target.add_child(picture);
    }

    _setHover(on) {
        const shift = on ? (this._left ? SHIFT : -SHIFT) : 0;
        if (this.has_allocation()) {
            this.ease({translation_x: shift, duration: HOVER_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            this.remove_all_transitions();
            this.translation_x = shift;
        }
        const close = this._close;
        close.remove_all_transitions();
        if (on)
            close.show();
        if (this.has_allocation()) {
            close.ease({opacity: on ? 255 : 0, duration: HOVER_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: finished => {
                    if (finished && !on)
                        close.hide();
                }});
        } else {
            close.opacity = on ? 255 : 0;
            close.visible = on;
        }
    }

    // Where the preview is on screen (for the (un)minimize animation).
    get cardRect() {
        const [x, y] = this._preview.get_transformed_position();
        const [width, height] = this._preview.get_transformed_size();
        return {x, y, width, height};
    }

    getDragActor() {
        return new Clutter.Clone({source: this._preview, width: this._preview.width,
            height: this._preview.height, opacity: 230});
    }

    getDragActorSource() {
        return this._preview;
    }
});
