// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// A chip next to Activities: a dot in the color of the scene on stage and its
// name. Clicking it brings the strip back when it is hidden.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {sceneColor} from './layout.js';
import {sceneName} from './sceneThumbnail.js';

export const SceneChip = GObject.registerClass(
class SceneChip extends PanelMenu.Button {
    _init(manager, strip) {
        super._init(0.5, 'Escenas', true);
        this._manager = manager;
        this._strip = strip;
        this.add_style_class_name('escenas-chip');
        const box = new St.BoxLayout({style_class: 'escenas-chip-box', y_align: Clutter.ActorAlign.CENTER});
        this._dot = new St.Widget({style_class: 'escenas-chip-dot', y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({style_class: 'escenas-chip-label', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._dot);
        box.add_child(this._label);
        this.add_child(box);
        this._changedId = manager.connect('changed', () => this._update());
        this._update();
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_RELEASE || event.type() === Clutter.EventType.TOUCH_END) {
            this._strip.reveal();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    _update() {
        const scene = this._manager.activeScene;
        this.visible = !!scene;
        if (!scene)
            return;
        this._dot.style = `background-color: ${sceneColor(scene)};`;
        this._label.text = sceneName(this._manager, scene);
    }

    destroy() {
        this._manager.disconnect(this._changedId);
        super.destroy();
    }
});
