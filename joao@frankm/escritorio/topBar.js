// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Hides GNOME's top bar (also in Activities) and frees the space it reserved, so maximized
// windows use the full height. Restored exactly as GNOME made it (visible, tracked with
// affectsStruts + trackFullscreen) on destroy and while the screen is locked: the lock
// screen is never touched. Key 'hide-top-bar'.
// GNOME's shortcuts for the bar's menus (Super+V, Super+M) would pop up a menu with nothing
// to hang from: while hidden, they open the page instead.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class TopBar {
    constructor(settings, openSection) {
        this._settings = settings;
        this._openSection = openSection;
        this._hidden = false;
        this._lockId = Main.sessionMode.connect('updated', () => this.sync());
        this._settingId = settings.connect('changed::hide-top-bar', () => this.sync());
        this.sync();
    }

    get hidden() {
        return this._hidden;
    }

    sync() {
        if (this._settings.get_boolean('hide-top-bar') && !Main.sessionMode.isLocked)
            this._hide();
        else
            this._show();
    }

    _hide() {
        if (this._hidden)
            return;
        this._hidden = true;
        const box = Main.layoutManager.panelBox;
        Main.layoutManager.untrackChrome(box);
        box.hide();
        Main.layoutManager._queueUpdateRegions?.();
        Main.panel.toggleCalendar = () => this._openSection('today');
        Main.panel.toggleQuickSettings = () => this._openSection('settings');
    }

    _show() {
        if (!this._hidden)
            return;
        this._hidden = false;
        // The instance's own functions go away and the class's are seen again.
        delete Main.panel.toggleCalendar;
        delete Main.panel.toggleQuickSettings;
        const box = Main.layoutManager.panelBox;
        box.show();
        Main.layoutManager.trackChrome(box, {affectsStruts: true, trackFullscreen: true});
        Main.layoutManager._queueUpdateRegions?.();
    }

    destroy() {
        Main.sessionMode.disconnect(this._lockId);
        this._settings.disconnect(this._settingId);
        this._show();
    }
}
