// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Foot of the panel: Ajustes, and Bloquear, Suspender, Reiniciar, Apagar through GNOME's
// SystemActions, so Reiniciar and Apagar ask with GNOME's own dialog. "Cerrar sesión" is in
// the right-click menu of Apagar.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {launchSettings} from './common.js';

const BUTTONS = [
    {id: 'lock', icon: 'system-lock-screen-symbolic', name: 'Bloquear', can: 'can-lock-screen', run: 'activateLockScreen'},
    {id: 'suspend', icon: 'media-playback-pause-symbolic', name: 'Suspender', can: 'can-suspend', run: 'activateSuspend'},
    {id: 'restart', icon: 'system-reboot-symbolic', name: 'Reiniciar', can: 'can-restart', run: 'activateRestart'},
    {id: 'poweroff', icon: 'system-shutdown-symbolic', name: 'Apagar', can: 'can-power-off', run: 'activatePowerOff'},
];
const RUNS = {...Object.fromEntries(BUTTONS.map(b => [b.id, b.run])), logout: 'activateLogout'};

export const PowerButtons = GObject.registerClass(
class JoaoPowerButtons extends St.BoxLayout {
    _init({tooltip, close}) {
        super._init({style_class: 'escenas-full-footer', x_expand: true});
        this._close = close;
        this._actions = SystemActions.getDefault();

        this.settingsButton = new St.Button({
            style_class: 'escenas-full-settings',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            label: 'Ajustes',
            accessible_name: 'Abrir Ajustes',
        });
        this.settingsButton.connect('clicked', () => this.run('settings'));
        tooltip.attach(this.settingsButton, 'Abrir Ajustes');
        this.add_child(this.settingsButton);

        const box = new St.BoxLayout({style_class: 'escenas-full-power'});
        this.buttons = {};
        for (const b of BUTTONS) {
            const button = new St.Button({
                style_class: `escenas-full-power-button ${b.id}`,
                can_focus: true,
                accessible_name: b.name,
                child: new St.Icon({icon_name: b.icon, icon_size: 18}),
            });
            button.connect('clicked', () => this.run(b.id));
            tooltip.attach(button, b.id === 'poweroff' ? 'Apagar · clic derecho: cerrar sesión' : b.name);
            this._actions.bind_property(b.can, button, 'visible', GObject.BindingFlags.SYNC_CREATE);
            box.add_child(button);
            this.buttons[b.id] = button;
        }
        this.add_child(box);
        this._buildMenu();
    }

    can(id) {
        if (id === 'settings')
            return true;
        if (id === 'logout')
            return this._actions.can_logout;
        return this.buttons[id].visible;
    }

    // The page holds the keyboard: it closes before a dialog or the lock screen.
    run(id) {
        this._close();
        if (id === 'settings')
            launchSettings();
        else
            this._actions[RUNS[id]]();
    }

    _buildMenu() {
        const button = this.buttons.poweroff;
        this._menu = new PopupMenu.PopupMenu(button, 0.5, St.Side.BOTTOM);
        // A signal, not a destroy() override: this widget is destroyed through its parent.
        this.connect('destroy', () => {
            this._menu.destroy();
            this._menu = null;
        });
        this._menu.actor.add_style_class_name('escenas-saved-menu');
        this._menuManager = new PopupMenu.PopupMenuManager(button, {actionMode: Shell.ActionMode.POPUP});
        this._menuManager.addMenu(this._menu);
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();
        const logout = this._menu.addAction('Cerrar sesión', () => this.run('logout'));
        this._actions.bind_property('can-logout', logout, 'visible', GObject.BindingFlags.SYNC_CREATE);
        button.connect('button-press-event', (a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this._menu.toggle();
            return Clutter.EVENT_STOP;
        });
    }

    closeMenu() {
        this._menu?.close(false);
    }
});
