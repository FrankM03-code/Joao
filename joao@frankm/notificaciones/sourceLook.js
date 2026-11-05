// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The name and icon a notification shows. Firefox does not say which site a notification comes
// from: to GNOME they are all "Firefox". On Frank's PC WhatsApp is the only site allowed to send
// them, so they can be shown as WhatsApp (key island-firefox-as-whatsapp).
import Gio from 'gi://Gio';

const CHAT_ICON = new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('iconos/chat-verde.svg'),
});

let settings = null;

export function useSettings(value) {
    settings = value;
}

export function isChat(source) {
    return !!settings?.get_boolean('island-firefox-as-whatsapp') &&
        /firefox/i.test(source?.app?.get_id() ?? '');
}

export const sourceName = source => (isChat(source) ? 'WhatsApp' : source?.title ?? '');

// What a chat sends as an image is the sender's picture, never something to preview.
export const hasPreview = source => !isChat(source);

export function sourceIcon(notification) {
    const {source} = notification;
    return isChat(source) ? notification.gicon ?? CHAT_ICON : source?.icon ?? null;
}
