// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Scenes: window groups with one on stage and the others in a strip at the side of the screen.
// A part of João that can be switched off from the preferences (modo-activo).
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SceneChip} from './sceneChip.js';
import {SceneManager} from './sceneManager.js';
import {StageStrip} from './stageStrip.js';

let current = null;

// What the rest of João asks for; null while the mode is off.
export const escenasManager = () => current?._manager ?? null;
export const escenasStrip = () => current?._strip ?? null;

export class EscenasMode {
    constructor(settings, view) {
        this._settings = settings;
        this._view = view;
        this._manager = null;
        current = this;
        this._settingsIds = [
            settings.connect('changed::modo-activo', () => this._syncMode()),
        ];
        this._addKey('atajo-alternar', () => settings.set_boolean('modo-activo', !settings.get_boolean('modo-activo')),
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        this._syncMode();
    }

    destroy() {
        Main.wm.removeKeybinding('atajo-alternar');
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._stop();
        current = null;
        this._settings = null;
    }

    _addKey(key, fn, mode = Shell.ActionMode.NORMAL) {
        Main.wm.addKeybinding(key, this._settings, Meta.KeyBindingFlags.NONE, mode, fn);
    }

    _syncMode() {
        if (this._settings.get_boolean('modo-activo'))
            this._start();
        else
            this._stop();
    }

    _start() {
        if (this._manager)
            return;
        this._manager = new SceneManager(this._settings);
        this._strip = new StageStrip(this._manager, this._settings, this._view);
        this._chip = new SceneChip(this._manager, this._strip);
        Main.panel.addToStatusArea('escenas-chip', this._chip, 1, 'left');
        this._manager.start();
        this._addKey('atajo-separar', () => this._manager?.separate());
    }

    _stop() {
        if (!this._manager)
            return;
        Main.wm.removeKeybinding('atajo-separar');
        this._chip.destroy();
        this._chip = null;
        this._strip.destroy();
        this._strip = null;
        this._manager.destroy();
        this._manager = null;
    }
}
