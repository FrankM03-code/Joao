// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The wide "+ Nueva escena" button at the top of the strip: a dashed
// rounded box the width of the strip. A click does what the old round "+"
// did; it is also where to drop something to make it a scene of its own:
//  - a window being moved by its title bar (the strip follows the grab and
//    calls setDrop / containsPoint()),
//  - anything dragged with GNOME's DND that carries a window (metaWindow) or a
//    thumbnail of the strip whose scene can give one window away.
// St draws no dashed borders, so the border is painted with Cairo.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

const LABEL = 'Nueva escena';
const DROP_LABEL = 'Suelta para crear escena';

export const NewSceneButton = GObject.registerClass(
class NewSceneButton extends St.Button {
    // @canTake(source): the window a DND @source would turn into a scene, or null.
    // @take(win): makes it a scene.
    _init({canTake, take}) {
        super._init({style_class: 'escenas-new-scene', can_focus: true, reactive: true, track_hover: true,
            x_expand: true, accessible_name: LABEL});
        this.set_pivot_point(0.5, 0.5);
        this._canTake = canTake;
        this._take = take;
        this._delegate = this;

        const layer = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._layer = layer;
        this.set_child(layer);
        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', () => this._paintBorder());
        layer.add_child(this._area);

        const content = new St.BoxLayout({style_class: 'escenas-new-scene-content',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({icon_name: 'list-add-symbolic', icon_size: 10, style_class: 'escenas-new-scene-icon',
            y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({text: LABEL, style_class: 'escenas-new-scene-label', y_align: Clutter.ActorAlign.CENTER});
        content.add_child(this._icon);
        content.add_child(this._label);
        layer.add_child(content);
        this._content = content;

        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._accentId = this._themeContext.connect('notify::accent-color', () => this._updateDropStyle());
        this.connect('style-changed', () => this._area.queue_repaint());
        this.connect('notify::hover', () => this._area.queue_repaint());
        this.connect('notify::pressed', () => this._onPressed());
        this.connect('destroy', () => this._onDestroy());

        this._dropping = false;
        this._dragMonitor = null;
        this._stopId = 0;
    }

    _onDestroy() {
        this._themeContext.disconnect(this._accentId);
        if (this._stopId)
            GLib.source_remove(this._stopId);
        this._stopId = 0;
        this._stopMonitor();
    }

    _onPressed() {
        this.remove_transition('scale-x');
        this.remove_transition('scale-y');
        const s = this.pressed ? 0.98 : 1;
        if (this.has_allocation())
            this.ease({scale_x: s, scale_y: s, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else
            this.scale_x = this.scale_y = s;
        this._area.queue_repaint();
    }

    // The system accent color as [r, g, b] in 0–1.
    _accent() {
        const [color] = this._themeContext.get_accent_color();
        return [color.red / 255, color.green / 255, color.blue / 255];
    }

    get dropping() {
        return this._dropping;
    }

    // Something that can become a scene is over the button (or not).
    // Something else shown inside the box, in place of its text (the strip's volume).
    addOverlay(actor) {
        this._layer.add_child(actor);
    }

    setContentHidden(hidden) {
        const opacity = hidden ? 0 : 255;
        this._content.remove_transition('opacity');
        if (this._content.has_allocation())
            this._content.ease({opacity, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else
            this._content.opacity = opacity;
    }

    setDrop(on) {
        if (on === this._dropping)
            return;
        this._dropping = on;
        if (on)
            this.add_style_class_name('drop-target');
        else
            this.remove_style_class_name('drop-target');
        this._label.text = on ? DROP_LABEL : LABEL;
        this._updateDropStyle();
    }

    // The accent tint is set here: the stylesheet cannot make the accent
    // color translucent.
    _updateDropStyle() {
        if (this._dropping) {
            const [r, g, b] = this._accent().map(v => Math.round(v * 255));
            this.style = `background-color: rgba(${r}, ${g}, ${b}, 0.2);`;
        } else {
            this.style = null;
        }
        this._area.queue_repaint();
    }

    // The point (stage coordinates) is on the button, with a little margin
    // (a window's title bar is hard to aim exactly).
    containsPoint(x, y, pad = 8) {
        if (!this.mapped)
            return false;
        const [bx, by] = this.get_transformed_position();
        const [bw, bh] = this.get_transformed_size();
        return x >= bx - pad && x < bx + bw + pad && y >= by - pad && y < by + bh + pad;
    }

    _paintBorder() {
        const cr = this._area.get_context();
        const [w, h] = this._area.get_surface_size();
        const node = this.get_theme_node();
        let rgb, alpha;
        if (this._dropping) {
            rgb = this._accent();
            alpha = 1;
        } else {
            const c = node.get_foreground_color();
            rgb = [c.red / 255, c.green / 255, c.blue / 255];
            alpha = this.hover || this.has_key_focus() ? 0.55 : 0.28;
        }
        cr.setSourceRGBA(...rgb, alpha);
        cr.setLineWidth(1);
        cr.setDash([3, 3], 0);
        const r = Math.min(9, h / 2 - 1);
        const x = 0.5, y = 0.5, rw = w - 1, rh = h - 1;
        cr.newSubPath();
        cr.arc(x + rw - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + rw - r, y + rh - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + rh - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
        cr.stroke();
        cr.$dispose();
    }

    // ---------- GNOME's drag and drop ----------

    handleDragOver(source) {
        if (!this._canTake(source))
            return DND.DragMotionResult.NO_DROP;
        this.setDrop(true);
        this._startMonitor();
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        const win = this._canTake(source);
        this.setDrop(false);
        this._idleStop();
        if (!win)
            return false;
        this._take(win);
        return true;
    }

    // Leaving the button (or the drag ending elsewhere) puts it back to normal.
    _startMonitor() {
        if (this._dragMonitor)
            return;
        this._dragMonitor = {
            dragMotion: event => {
                if (event.targetActor !== this && !this.contains(event.targetActor)) {
                    this.setDrop(false);
                    this._idleStop();
                }
                return DND.DragMotionResult.CONTINUE;
            },
            dragDrop: () => {
                // Not removed right here: GNOME is going through its monitor list.
                this.setDrop(false);
                this._idleStop();
                return DND.DragDropResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);
    }

    _idleStop() {
        if (this._stopId)
            return;
        this._stopId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._stopId = 0;
            this._stopMonitor();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopMonitor() {
        if (!this._dragMonitor)
            return;
        DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
    }
});
