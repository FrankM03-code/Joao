// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The apps of a saved scene waiting in the strip: nothing is open until one is clicked, and then
// it takes the stage like any new window. An app that gets a window leaves the list by itself.
// Kept in the settings, so they survive reloading the shell.
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

const KEY = 'strip-shortcuts';
const ROW = 44;             // a row and its spacing (stylesheet)
const MAX_SHARE = 0.4;      // of the work area; beyond it the list scrolls

// activate() does nothing while GNOME still counts the app as starting, and it can stay so
// for a while after its window was closed. Only a running app with one main window is
// brought up instead of launched.
export function launch(app) {
    if (app.state === Shell.AppState.RUNNING && !app.can_open_new_window())
        app.activate();
    else
        app.open_new_window(-1);
}

const lookup = id => Shell.AppSystem.get_default().lookup_app(id);

export class AppShortcuts {
    constructor(settings) {
        this._settings = settings;
        this._box = new St.BoxLayout({style_class: 'escenas-shortcuts', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.actor = new St.ScrollView({
            style_class: 'escenas-shortcuts-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._box,
            visible: false,
        });
    }

    get ids() {
        return this._settings.get_strv(KEY);
    }

    // Replaces what is waiting with these apps, leaving out those already open.
    show(ids) {
        const unique = [...new Set(ids)].filter(id => {
            const app = lookup(id);
            return app && !app.get_windows().length;
        });
        this._settings.set_strv(KEY, unique);
    }

    _remove(id) {
        this._settings.set_strv(KEY, this.ids.filter(i => i !== id));
    }

    // Drops what has opened or was uninstalled, and draws the rest for @maxHeight of the work area.
    sync(workHeight) {
        const ids = this.ids;
        const kept = ids.filter(id => {
            const app = lookup(id);
            return app && !app.get_windows().length;
        });
        if (kept.length !== ids.length)
            this._settings.set_strv(KEY, kept);
        this._box.destroy_all_children();
        kept.forEach(id => this._box.add_child(this._row(lookup(id))));
        this.actor.visible = kept.length > 0;
        this._height = kept.length ? Math.min(kept.length * ROW, Math.max(ROW, Math.floor(workHeight * MAX_SHARE))) : 0;
        this.actor.height = this._height;
    }

    // What the strip has to leave for the list, its spacing included.
    get height() {
        return this._height ? this._height + 10 : 0;
    }

    _row(app) {
        const id = app.get_id();
        const name = app.get_name();
        const row = new St.BoxLayout({style_class: 'escenas-shortcut', x_expand: true, reactive: true, track_hover: true});
        const open = new St.Button({style_class: 'escenas-shortcut-open', can_focus: true, x_expand: true,
            accessible_name: `Abrir ${name}`});
        const content = new St.BoxLayout({x_expand: true});
        const icon = app.create_icon_texture(24);
        icon.y_align = Clutter.ActorAlign.CENTER;
        content.add_child(icon);
        content.add_child(new St.Label({style_class: 'escenas-shortcut-name', text: name, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        open.set_child(content);
        open.connect('clicked', () => {
            this._remove(id);
            launch(app);
        });
        row.add_child(open);
        const remove = new St.Button({style_class: 'escenas-shortcut-remove', can_focus: true, y_align: Clutter.ActorAlign.CENTER,
            accessible_name: `Quitar ${name} de la franja`, child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12})});
        remove.connect('clicked', () => this._remove(id));
        row.add_child(remove);
        return row;
    }
}
