// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What can be done to a saved scene from the page: save, rename, change layout, delete,
// and the right-click menus that lead there.
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {captureWindows} from '../escenas/escenasLink.js';
import {lookupApp} from './savedSceneCard.js';
import {ConfirmDialog, SaveSceneDialog} from './saveSceneDialog.js';

export class SceneEditor {
    constructor(view) {
        this._view = view;
        this.menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(view, {actionMode: Shell.ActionMode.POPUP});
    }

    saveCurrent() {
        const windows = captureWindows();
        if (!windows.length)
            return;
        const dialog = new SaveSceneDialog({
            title: 'Guardar la escena actual',
            actionLabel: 'Guardar',
            name: windows.at(-1).appName,
            windows,
            store: this._view._store,
            allowReplace: true,
            onDone: ({name, layout, replaceId}) => {
                this._view._store.saveScene({name, layout, windows, replaceId});
                this._view._populate();
            },
        });
        this._openDialog(dialog);
    }

    rename(scene) {
        this._openDialog(new SaveSceneDialog({
            title: 'Renombrar la escena',
            actionLabel: 'Renombrar',
            name: scene.name,
            windows: scene.windows,
            store: this._view._store,
            self: scene.id,
            showLayout: false,
            onDone: ({name}) => {
                this._view._store.rename(scene.id, name);
                this._view._populate();
            },
        }));
    }

    changeLayout(scene) {
        this._openDialog(new SaveSceneDialog({
            title: `Cambiar la distribución de «${scene.name}»`,
            actionLabel: 'Guardar',
            layout: scene.layout,
            windows: scene.windows,
            store: this._view._store,
            self: scene.id,
            showName: false,
            onDone: ({layout}) => {
                this._view._store.setLayout(scene.id, layout);
                this._view._populate();
            },
        }));
    }

    delete(scene) {
        this._openDialog(new ConfirmDialog({
            title: `¿Eliminar «${scene.name}»?`,
            description: 'Se borra la escena guardada. Las apps y las ventanas abiertas no se tocan.',
            actionLabel: 'Eliminar',
            onConfirm: () => {
                this._view._store.remove(scene.id);
                this._view._populate();
            },
        }));
    }

    _openDialog(dialog) {
        dialog.connect('closed', () => {
            if (this._view.isOpen)
                this._view._entry.grab_key_focus();
        });
        dialog.open(global.get_current_time());
    }

    disableSuggestion() {
        if (this._view._suggested)
            this._view._store.disableSuggestion(this._view._suggested.id);
        this._view._populate();
        this._view._entry.grab_key_focus();
    }

    _showMenu(source, fill) {
        this.menu?.destroy();
        const menu = new PopupMenu.PopupMenu(source, 0.5, St.Side.TOP);
        this.menu = menu;
        menu.actor.add_style_class_name('escenas-saved-menu');
        Main.uiGroup.add_child(menu.actor);
        this._menuManager.addMenu(menu);
        fill((label, fn, enabled = true) => {
            const item = menu.addAction(label, this._afterMenu(fn));
            item.setSensitive(enabled);
        });
        let gone = false;
        menu.connect('destroy', () => {
            gone = true;
        });
        menu.connect('open-state-changed', (m, open) => {
            if (open)
                return;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this.menu === menu)
                    this.menu = null;
                if (!gone)
                    menu.destroy();
                return GLib.SOURCE_REMOVE;
            });
        });
        menu.open(true);
    }

    // Runs after the menu let go of the keyboard, so a dialog can take it.
    _afterMenu(fn) {
        return () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._view.isOpen)
                fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    openCardMenu(card) {
        const scene = card.scene;
        const current = captureWindows();
        const addRemoveApps = () => {
            const sub = new PopupMenu.PopupSubMenuMenuItem('Quitar app');
            for (const w of [...scene.windows].sort((a, b) => a.order - b.order)) {
                sub.menu.addAction(lookupApp(w.appId)?.get_name() ?? (w.appName || w.appId), this._afterMenu(() => {
                    this._view._store.removeWindow(scene.id, w);
                    this._view._populate();
                }));
            }
            this.menu.addMenuItem(sub);
        };
        this._showMenu(card, add => {
            add('Abrir', () => this._view._openScene(scene));
            add('Abrir en otro espacio de trabajo', () => this._view._openScene(scene, {newWorkspace: true}));
            add('Renombrar…', () => this.rename(scene));
            add('Cambiar distribución…', () => this.changeLayout(scene));
            add('Actualizar con la escena actual', () => {
                this._view._store.updateWindows(scene.id, current);
                this._view._populate();
            }, current.length > 0);
            add('Fijar como sugerencia para esta hora', () => {
                this._view._store.pinSuggestion(scene.id);
                this._view._populate();
            });
            add('No sugerir', () => {
                this._view._store.disableSuggestion(scene.id);
                this._view._populate();
            });
            if (scene.windows.length > 1)
                addRemoveApps();
            add('Eliminar', () => this.delete(scene));
        });
    }

    openSuggestionMenu() {
        this._showMenu(this._view._suggestionOpen, add => {
            add('No sugerir esta escena', () => this.disableSuggestion());
        });
    }

    destroy() {
        this.menu?.destroy();
        this.menu = null;
    }
}
