// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The Super key alone (GNOME's 'overlay-key') toggles João instead of Activities.
// GNOME's handler is blocked while this runs and always unblocked on destroy.
// Activities stays reachable with Super+A. Key 'replace-super'.
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

export class SuperKey {
    constructor(onSuper) {
        this._blocked = GObject.signal_handlers_block_matched(global.display, {signalId: 'overlay-key'});
        this._id = global.display.connect('overlay-key', () => onSuper());
        // POPUP too: Super closes the page while it holds the keyboard.
        Main.wm.allowKeybinding('overlay-key', MODES | Shell.ActionMode.POPUP);
    }

    destroy() {
        Main.wm.allowKeybinding('overlay-key', MODES);
        global.display.disconnect(this._id);
        if (this._blocked)
            GObject.signal_handlers_unblock_matched(global.display, {signalId: 'overlay-key'});
    }
}
