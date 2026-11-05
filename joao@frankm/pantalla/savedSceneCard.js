// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The cards of the page: a saved scene with its layout thumbnail, and "Guardar la escena actual".
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {layoutRects, layoutSummary} from '../escenas/layouts.js';
import {PALETTE} from '../franja/layout.js';

const CARD_THUMB = 82;   // what fits in a card of the page's height, with its two lines
const THUMB_MARGIN = 4;
const THUMB_HEIGHT = 112;

// A color per app: always the same one, also with the app closed.
function appColor(appId) {
    let hash = 2166136261;
    for (const ch of appId)
        hash = Math.imul(hash ^ ch.codePointAt(0), 16777619);
    return PALETTE[(hash >>> 13) % PALETTE.length];
}

export const lookupApp = id => Shell.AppSystem.get_default().lookup_app(id);

export function appNames(scene) {
    const names = [...new Set(scene.windows.map(w => lookupApp(w.appId)?.get_name() ?? (w.appName || w.appId)))];
    if (names.length < 2)
        return names.join('');
    return `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
}

function sceneSummary(scene) {
    const count = new Set(scene.windows.map(w => w.appId)).size;
    return `${count} ${count === 1 ? 'app' : 'apps'} · ${layoutSummary(scene.layout)}`;
}

// A drawing of the layout, not screenshots: it works with the apps closed.
export const LayoutThumb = GObject.registerClass(
class JoaoLayoutThumb extends St.Widget {
    _init(width, height = THUMB_HEIGHT) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        super._init({style_class: 'escenas-saved-thumb', width, height: height * scale});
        this._w = width;
        this._h = height * scale;
    }

    show_(layout, windows) {
        this.destroy_all_children();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const sorted = [...windows].sort((a, b) => a.order - b.order);
        const area = {x: 0, y: 0, width: this._w, height: this._h};
        const margin = THUMB_MARGIN * scale;
        const rects = layoutRects(layout, sorted, area, margin);
        sorted.forEach((w, i) => {
            let r = rects[i];
            // Saved positions touch each other: same margin as the computed layouts.
            if (layout === 'free') {
                const half = margin / 2;
                r = {
                    x: Math.max(r.x, 0) + half, y: Math.max(r.y, 0) + half,
                    width: Math.max(1, Math.min(r.width, this._w - r.x) - margin),
                    height: Math.max(1, Math.min(r.height, this._h - r.y) - margin),
                };
            }
            this.add_child(new St.Widget({
                style_class: 'escenas-saved-thumb-window',
                style: `background-color: ${appColor(w.appId)};`,
                x: r.x, y: r.y, width: r.width, height: r.height,
            }));
        });
    }
});

const SWITCH_TRACK = 28;    // keep in step with stylesheet.css (.escenas-saved-toggle-knob)
const SWITCH_KNOB = 14;

export const SavedSceneCard = GObject.registerClass(
class JoaoSavedSceneCard extends St.Button {
    _init(scene, width, height, {suggested = false} = {}) {
        super._init({
            style_class: 'escenas-saved-card',
            can_focus: true,
            reactive: true,
            width,
            height,
        });
        this.scene = scene;
        if (suggested)
            this.add_style_class_name('suggested');
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const box = new St.BoxLayout({style_class: 'escenas-saved-card-box', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.set_child(box);

        const thumb = new LayoutThumb(Math.round(width - 28 * scale), CARD_THUMB);
        thumb.show_(scene.layout, scene.windows);
        box.add_child(thumb);

        const row = new St.BoxLayout({x_expand: true});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.nameLabel = new St.Label({style_class: 'escenas-saved-card-name', text: scene.name});
        text.add_child(this.nameLabel);
        text.add_child(new St.Label({style_class: 'escenas-saved-card-summary', text: sceneSummary(scene)}));
        row.add_child(text);
        this.openSwitch = this._makeSwitch(scene, scale);
        row.add_child(this.openSwitch);
        box.add_child(row);
    }

    // On: a click on the card opens the scene's apps. Off: they wait in the strip.
    _makeSwitch(scene, scale) {
        const toggle = new St.Button({
            style_class: 'escenas-saved-toggle',
            toggle_mode: true,
            checked: !!scene.openApps,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Abrir sus apps al hacer clic',
        });
        const track = new St.Widget({width: SWITCH_TRACK * scale, height: SWITCH_KNOB * scale});
        const knob = new St.Widget({style_class: 'escenas-saved-toggle-knob'});
        track.add_child(knob);
        toggle.set_child(track);
        const place = () => knob.set_x(toggle.checked ? (SWITCH_TRACK - SWITCH_KNOB) * scale : 0);
        toggle.connect('notify::checked', place);
        place();
        return toggle;
    }
});

// "Guardar la escena actual" and "Nueva escena". Same size as a scene card, with a
// dotted border (St cannot paint one: Cairo does).
export const DottedCard = GObject.registerClass(
class JoaoDottedCard extends St.Button {
    _init(width, height, {label, hint = '', iconName = 'list-add-symbolic', enabled = true}) {
        super._init({
            style_class: 'escenas-saved-add',
            can_focus: enabled,
            reactive: enabled,
            opacity: enabled ? 255 : 128,
            width,
            height,
        });
        const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this.set_child(stack);
        const border = new St.DrawingArea({x_expand: true, y_expand: true});
        border.connect('repaint', area => this._paintBorder(area));
        stack.add_child(border);
        const box = new St.BoxLayout({
            style_class: 'escenas-saved-add-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Bin({
            style_class: 'escenas-saved-add-circle',
            x_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: iconName, icon_size: 20}),
        }));
        box.add_child(new St.Label({style_class: 'escenas-saved-add-label', text: label, x_align: Clutter.ActorAlign.CENTER}));
        if (hint)
            box.add_child(new St.Label({style_class: 'escenas-saved-add-hint', text: hint, x_align: Clutter.ActorAlign.CENTER}));
        stack.add_child(box);
    }

    _paintBorder(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const line = 1.5 * scale;
        const r = 20 * scale;
        const m = line / 2;
        cr.setSourceRGBA(1, 1, 1, 0.55);
        cr.setLineWidth(line);
        cr.setDash([5 * scale, 5 * scale], 0);
        cr.newSubPath();
        cr.arc(w - r - m, r + m, r, -Math.PI / 2, 0);
        cr.arc(w - r - m, h - r - m, r, 0, Math.PI / 2);
        cr.arc(r + m, h - r - m, r, Math.PI / 2, Math.PI);
        cr.arc(r + m, r + m, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
        cr.stroke();
        cr.$dispose();
    }
});
