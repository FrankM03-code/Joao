// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// João stays on while the screen is locked, but listens to no key there: this handler exists only
// while the session is unlocked.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export function connectKeyPress(actor, onKey) {
    let id = 0;
    const sync = () => {
        if (Main.sessionMode.isLocked && id) {
            actor.disconnect(id);
            id = 0;
        } else if (!Main.sessionMode.isLocked && !id) {
            id = actor.connect('key-press-event', (a, event) => onKey(event));
        }
    };
    const modeId = Main.sessionMode.connect('updated', sync);
    actor.connect('destroy', () => Main.sessionMode.disconnect(modeId));
    sync();
}
