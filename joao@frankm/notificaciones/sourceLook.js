// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The name and icon a notification shows. Firefox does not say which site a notification comes
// from: to GNOME they are all "Firefox". When a single chat site is allowed to send them, they can
// be shown under that site's name (keys firefox-as-chat and firefox-chat-name).
import Gio from 'gi://Gio';

let settings = null;

export function useSettings(value) {
    settings = value;
}

export function isChat(source) {
    return !!settings?.get_boolean('firefox-as-chat') &&
        /firefox/i.test(source?.app?.get_id() ?? '');
}

export const sourceName = source => (isChat(source) ? settings.get_string('firefox-chat-name') : source?.title ?? '');

// What a chat sends as an image is the sender's picture, never something to preview.
export const hasPreview = source => !isChat(source);

export function sourceIcon(notification) {
    const {source} = notification;
    if (!isChat(source))
        return source?.icon ?? null;
    return notification.gicon ?? new Gio.FileIcon({
        file: Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('iconos/chat-verde.svg'),
    });
}
