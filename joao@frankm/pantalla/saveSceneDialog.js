// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The small dialogs: save a scene, rename it, change its layout, and confirm a deletion.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';

import {arrangeFor, LAYOUTS} from '../escenas/layouts.js';
import {LayoutThumb} from './savedSceneCard.js';

const PREVIEW_WIDTH = 300;
const PREVIEW_HEIGHT = 170;

// @showName / @showLayout pick the fields. @store finds name clashes; @self is the scene
// being edited (its own name is no clash). @allowReplace offers "Reemplazar" on a clash.
// onDone({name, layout, replaceId}).
export const SaveSceneDialog = GObject.registerClass(
class JoaoSaveSceneDialog extends ModalDialog.ModalDialog {
    _init({title, actionLabel, name = '', layout = 'free', windows, store, self = null,
        showName = true, showLayout = true, allowReplace = false, onDone}) {
        super._init({styleClass: 'escenas-saved-dialog'});
        this._actionLabel = actionLabel;
        this._layout = layout;
        this._windows = windows;
        this._store = store;
        this._self = self;
        this._allowReplace = allowReplace;
        this._showName = showName;
        this._onDone = onDone;

        const box = new St.BoxLayout({style_class: 'escenas-saved-dialog-box', orientation: Clutter.Orientation.VERTICAL});
        this.contentLayout.add_child(box);
        box.add_child(new St.Label({style_class: 'escenas-saved-dialog-title', text: title}));

        if (showName) {
            box.add_child(new St.Label({style_class: 'escenas-saved-dialog-field', text: 'Nombre'}));
            this._entry = new St.Entry({style_class: 'escenas-saved-dialog-entry', can_focus: true, text: name});
            ShellEntry.addContextMenu(this._entry);
            this._entry.clutter_text.connect('text-changed', () => this._sync());
            this._entry.clutter_text.connect('activate', () => this._confirm());
            box.add_child(this._entry);
            this._clash = new St.Label({style_class: 'escenas-saved-dialog-clash', visible: false});
            box.add_child(this._clash);
            this.setInitialKeyFocus(this._entry);
        }

        if (showLayout) {
            box.add_child(new St.Label({style_class: 'escenas-saved-dialog-field', text: 'Distribución'}));
            const row = new St.BoxLayout({style_class: 'escenas-saved-dialog-layouts'});
            this._layoutButtons = new Map();
            for (const l of LAYOUTS) {
                const button = new St.Button({
                    style_class: 'escenas-saved-dialog-layout',
                    label: l.label,
                    can_focus: true,
                    x_expand: true,
                });
                button.connect('clicked', () => this._setLayout(l.id));
                row.add_child(button);
                this._layoutButtons.set(l.id, button);
            }
            box.add_child(row);
            this._preview = new LayoutThumb(PREVIEW_WIDTH, PREVIEW_HEIGHT);
            this._preview.x_align = Clutter.ActorAlign.CENTER;
            box.add_child(this._preview);
            this._setLayout(layout);
        }

        this.addButton({label: 'Cancelar', action: () => this.close(), key: Clutter.KEY_Escape});
        this._action = this.addButton({label: actionLabel, action: () => this._confirm(), default: true});
        this._sync();
    }

    _setLayout(id) {
        this._layout = id;
        for (const [key, button] of this._layoutButtons) {
            if (key === id)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        this._preview.show_(id, arrangeFor(id, this._windows));
    }

    _sync() {
        if (!this._showName)
            return;
        const text = this._entry.text.trim();
        const other = text ? this._store.byName(text) : null;
        this._other = other && other.id !== this._self ? other : null;
        this._clash.visible = !!this._other;
        this._clash.text = this._allowReplace
            ? `Ya hay una escena llamada «${text}». Puedes reemplazarla o cambiar el nombre.`
            : `Ya hay una escena llamada «${text}». Elige otro nombre.`;
        const ok = !!text && (!this._other || this._allowReplace);
        this._action.reactive = ok;
        this._action.can_focus = ok;
        this._action.label = this._other && this._allowReplace ? 'Reemplazar' : this._actionLabel;
        this._action.opacity = ok ? 255 : 128;
    }

    _confirm() {
        if (this._showName && !this._action.reactive)
            return;
        const result = {
            name: this._showName ? this._entry.text.trim() : null,
            layout: this._layout,
            replaceId: this._other?.id ?? null,
        };
        this.close();
        this._onDone(result);
    }
});

export const ConfirmDialog = GObject.registerClass(
class JoaoConfirmDialog extends ModalDialog.ModalDialog {
    _init({title, description, actionLabel, onConfirm}) {
        super._init({styleClass: 'escenas-saved-dialog'});
        this.contentLayout.add_child(new Dialog.MessageDialogContent({title, description}));
        this.addButton({label: 'Cancelar', action: () => this.close(), key: Clutter.KEY_Escape});
        this.addButton({
            label: actionLabel,
            default: true,
            action: () => {
                this.close();
                onConfirm();
            },
        });
    }
});
