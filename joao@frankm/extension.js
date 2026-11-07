// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// João: created and designed by Frank Molina.
// João: one desktop for GNOME Shell. Window scenes with a strip at the side of the screen, and a
// full-screen launcher that replaces the top bar: it saves which apps go together and how they are
// laid out, and holds the clock, the status icons, the quick settings, the week, the notifications
// and the power buttons.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {CornerIndicator} from './privacidad/cornerIndicator.js';
import {PrivacyMonitor} from './privacidad/privacyMonitor.js';
import {forgetColors} from './notificaciones/bubbleLook.js';
import {NotificationStore} from './notificaciones/notificationStore.js';
import {TrayBridge} from './notificaciones/trayBridge.js';
import {KeepAwake} from './sistema/keepAwake.js';
import {destroyNoticeSource} from './sistema/notice.js';
import {SavedScenesStore} from './escenas/savedScenesStore.js';
import {SavedScenesView} from './pantalla/savedScenesView.js';
import {SceneRestorer} from './escenas/sceneRestorer.js';
import {DesktopAtLogin} from './escritorio/startup.js';
import {EscenasMode} from './franja/escenasMode.js';
import {SuperKey} from './escritorio/superKey.js';
import {TopBar} from './escritorio/topBar.js';
import {Tiling} from './ventanas/tiling.js';

const WM_SCHEMA = 'org.gnome.desktop.wm.keybindings';
const SHELL_SCHEMA = 'org.gnome.shell.keybindings';
const MUTTER_SCHEMA = 'org.gnome.mutter.keybindings';
// GNOME's own shortcuts that João's defaults use; one accelerator can only have one owner.
const GNOME_KEYS = {
    'switch-input-source': WM_SCHEMA,
    'switch-input-source-backward': WM_SCHEMA,
    'toggle-quick-settings': SHELL_SCHEMA,
    'focus-active-notification': SHELL_SCHEMA,
    'toggle-tiled-left': MUTTER_SCHEMA,
    'toggle-tiled-right': MUTTER_SCHEMA,
    'maximize': WM_SCHEMA,
    'unmaximize': WM_SCHEMA,
};
const SHORTCUTS = ['saved-scenes-shortcut', 'launcher-today-shortcut', 'launcher-settings-shortcut'];
const TILE_SHORTCUTS = {
    'tile-left-shortcut': 'left',
    'tile-right-shortcut': 'right',
    'tile-up-shortcut': 'up',
    'tile-down-shortcut': 'down',
};

// '<Shift><Super>space' and '<Super><Shift>space' are the same accelerator.
function normalize(accel) {
    const mods = (accel.match(/<[^>]+>/g) ?? []).map(m => m.toLowerCase()).sort();
    return mods.join('') + accel.replace(/<[^>]+>/g, '').toLowerCase();
}

export default class JoaoExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._gnomeSettings = {
            [WM_SCHEMA]: new Gio.Settings({schema_id: WM_SCHEMA}),
            [SHELL_SCHEMA]: new Gio.Settings({schema_id: SHELL_SCHEMA}),
            [MUTTER_SCHEMA]: new Gio.Settings({schema_id: MUTTER_SCHEMA}),
        };
        this._keepAwake = new KeepAwake(this._settings);
        this._privacyMonitor = new PrivacyMonitor();
        this._notificationStore = new NotificationStore();
        this._store = new SavedScenesStore();
        this._restorer = new SceneRestorer(this._settings, this._store);
        this._view = new SavedScenesView(this._settings, this._store, this._restorer);
        this._escenas = new EscenasMode(this._settings, this._view);
        this._topBar = new TopBar(this._settings, section => this._view.showSection(section));
        this._privacy = new CornerIndicator(this._settings, this._topBar, this._view);
        this._notifications = new TrayBridge(this._settings, this._view);
        this._privacy.keepBelow(this._notifications.island);
        this._tiling = new Tiling(this._settings);

        // Mutter grabs a key again only after it hears about the change in GNOME's list;
        // a binding added before that stays dead, so it is added again then.
        this._gnomeIds = Object.entries(GNOME_KEYS).map(([key, schema]) =>
            [this._gnomeSettings[schema], this._gnomeSettings[schema].connect(`changed::${key}`, () => this._bindLater())]);
        this._giveBackKeys();
        this._takeKeys();
        this._bind();
        this._settingsIds = [
            this._settings.connect('changed::replace-super', () => this._syncSuper()),
            ...[...SHORTCUTS, ...Object.keys(TILE_SHORTCUTS), 'tiling-activo'].map(key => this._settings.connect(`changed::${key}`, () => {
                this._giveBackKeys();
                this._takeKeys();
                this._bind();
            })),
        ];
        this._syncSuper();
        this._lockId = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.isLocked)
                this._view.close({animate: false});
        });
        this._startup = new DesktopAtLogin(() => {
            if (this._settings.get_boolean('saved-scenes-on-login'))
                this._view.open();
        });
    }

    disable() {
        // João uses the "unlock-dialog" session mode because the scenes exist only in memory:
        // disabling on every lock would lose which windows go together and bring back every window
        // the strip keeps minimized, on top of rewriting GNOME's shortcuts each time. While locked
        // it shows nothing: the page closes, the strip hides, the top bar returns, and no key
        // handler stays connected (escritorio/keyEvents.js).
        this._startup.destroy();
        this._startup = null;
        this._keepAwake.destroy();
        this._keepAwake = null;
        destroyNoticeSource();
        Main.sessionMode.disconnect(this._lockId);
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._superKey?.destroy();
        this._superKey = null;
        this._gnomeIds.forEach(([settings, id]) => settings.disconnect(id));
        if (this._bindId)
            GLib.source_remove(this._bindId);
        this._bindId = 0;
        this._unbind();
        this._tiling.destroy();
        this._tiling = null;
        this._notifications.destroy();
        this._notifications = null;
        forgetColors();
        this._privacy.destroy();
        this._privacy = null;
        this._topBar.destroy();
        this._topBar = null;
        this._view.destroy();
        this._view = null;
        this._restorer.destroy();
        this._restorer = null;
        this._escenas.destroy();
        this._escenas = null;
        this._store.destroy();
        this._store = null;
        this._notificationStore.destroy();
        this._notificationStore = null;
        this._privacyMonitor.destroy();
        this._privacyMonitor = null;
        this._giveBackKeys();
        this._gnomeSettings = null;
        this._settings = null;
    }

    _syncSuper() {
        const on = this._settings.get_boolean('replace-super');
        if (on && !this._superKey)
            this._superKey = new SuperKey(() => this._view.toggle());
        else if (!on && this._superKey) {
            this._superKey.destroy();
            this._superKey = null;
        }
    }

    // Mutter takes its grab off the key some time after the change (longer while the
    // shell is starting up): bind again shortly after and once more a bit later.
    _bindLater() {
        if (this._bindId)
            GLib.source_remove(this._bindId);
        const tries = [200, 1800];
        const next = () => {
            this._bindId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, tries.shift(), () => {
                this._bindId = 0;
                this._bind();
                if (tries.length)
                    next();
                return GLib.SOURCE_REMOVE;
            });
        };
        next();
    }

    _bind() {
        this._unbind();
        const actions = {
            'saved-scenes-shortcut': () => this._view.toggle(),
            'launcher-today-shortcut': () => this._view.showSection('today'),
            'launcher-settings-shortcut': () => this._view.showSection('settings'),
        };
        this._bound = SHORTCUTS.filter(key => this._settings.get_strv(key).length);
        for (const key of this._bound) {
            Main.wm.addKeybinding(key, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, actions[key]);
        }
        // Only on the desktop: the launcher uses the arrows itself.
        const tileKeys = this._tileKeys().filter(key => this._settings.get_strv(key).length);
        for (const key of tileKeys) {
            Main.wm.addKeybinding(key, this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
                () => this._tiling?.key(TILE_SHORTCUTS[key]));
        }
        this._bound.push(...tileKeys);
    }

    _tileKeys() {
        return this._settings.get_boolean('tiling-activo') ? Object.keys(TILE_SHORTCUTS) : [];
    }

    _unbind() {
        (this._bound ?? []).forEach(key => Main.wm.removeKeybinding(key));
        this._bound = [];
    }

    // Takes João's accelerators off GNOME's lists and remembers exactly what it took.
    _takeKeys() {
        const mine = [...SHORTCUTS, ...this._tileKeys()].flatMap(key => this._settings.get_strv(key)).map(normalize);
        const taken = {};
        for (const [key, schema] of Object.entries(GNOME_KEYS)) {
            const settings = this._gnomeSettings[schema];
            const current = settings.get_strv(key);
            const kept = current.filter(a => !mine.includes(normalize(a)));
            if (kept.length === current.length)
                continue;
            taken[key] = current.filter(a => !kept.includes(a));
            settings.set_strv(key, kept);
        }
        if (Object.keys(taken).length)
            this._settings.set_string('wm-keys-taken', JSON.stringify(taken));
    }

    // Puts back what João took and keeps anything the user added meanwhile.
    _giveBackKeys() {
        let taken = {};
        try {
            taken = JSON.parse(this._settings.get_string('wm-keys-taken'));
        } catch (e) {
            logError(e, 'João: wm-keys-taken');
        }
        for (const [key, accels] of Object.entries(taken)) {
            const settings = this._gnomeSettings[GNOME_KEYS[key]];
            if (!settings)
                continue;
            const now = settings.get_strv(key);
            settings.set_strv(key, [...accels, ...now.filter(a => !accels.includes(a))]);
        }
        this._settings.set_string('wm-keys-taken', '{}');
    }
}
