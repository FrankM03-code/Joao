// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Logging in lands on the desktop, not on GNOME's Activities: GNOME decides by hasOverview, so
// it is off while the shell starts and back on right after, when Activities works as always.
// Extensions load asynchronously and GNOME does not wait for them: if its animation into
// Activities has already begun, its layer goes away at once and it is closed when it ends
// (it cannot be closed during that animation).
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class DesktopAtLogin {
    constructor(onReady) {
        this._onReady = onReady;
        if (!Main.layoutManager._startingUp)
            return;
        this._hadOverview = Main.sessionMode.hasOverview;
        Main.sessionMode.hasOverview = false;
        if (Main.overview.visible)
            Main.layoutManager.overviewGroup.hide();
        this._startupId = Main.layoutManager.connect('startup-complete', () => this._done());
    }

    _done() {
        Main.layoutManager.disconnect(this._startupId);
        this._startupId = 0;
        if (Main.overview.visible)
            Main.overview.hide();
        // After every other 'startup-complete' handler: another extension doing the same
        // must not leave Activities switched off for good.
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            this._restore();
            return GLib.SOURCE_REMOVE;
        });
        this._onReady?.();
    }

    _restore() {
        if (this._hadOverview !== undefined)
            Main.sessionMode.hasOverview = this._hadOverview;
        this._hadOverview = undefined;
    }

    destroy() {
        if (this._startupId)
            Main.layoutManager.disconnect(this._startupId);
        this._startupId = 0;
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._restore();
    }
}
