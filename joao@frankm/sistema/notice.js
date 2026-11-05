// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// João's own messages: they say "João", not GNOME's "Sistema".
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

let source = null;

export function notify(title, body = null) {
    if (!source) {
        source = new MessageTray.Source({title: 'João', iconName: 'view-app-grid-symbolic'});
        source.connect('destroy', () => {
            source = null;
        });
        Main.messageTray.add(source);
    }
    source.addNotification(new MessageTray.Notification({source, title, body, isTransient: true}));
}

export function destroyNoticeSource() {
    source?.destroy();
}
