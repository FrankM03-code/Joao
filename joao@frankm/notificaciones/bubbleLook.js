// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What the bubble shows of a notification: the colour of its app and the short line of text.
import Gio from 'gi://Gio';
import St from 'gi://St';

import {plainBody} from '../sistema/notifications.js';
import {isChat, sourceName} from './sourceLook.js';

const SYSTEM_COLOR = [0x35, 0x84, 0xe4];    // no app behind it: a screenshot, the battery
const CHAT_COLOR = [0x25, 0xa5, 0x5f];      // iconos/chat-verde.svg
const ACCENT = {
    blue: [0x35, 0x84, 0xe4],
    teal: [0x21, 0x90, 0xa4],
    green: [0x3a, 0x94, 0x4a],
    yellow: [0xc8, 0x88, 0x00],
    orange: [0xed, 0x5b, 0x00],
    red: [0xe6, 0x2d, 0x42],
    pink: [0xd5, 0x61, 0x99],
    purple: [0x91, 0x41, 0xac],
    slate: [0x6f, 0x83, 0x96],
};
const SAMPLE = 48;          // px of the icon
const HUES = 12;
const MIN_SATURATION = 0.25;
const MIN_ALPHA = 128;
const CAPTION_MAX = 32;     // characters

const cache = new Map();    // app id -> colour, or null when the icon has none

function hsv(r, g, b) {
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    if (!delta)
        return {hue: 0, saturation: 0};
    let hue = max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta;
    hue = (hue + 6) % 6 / 6;
    return {hue, saturation: delta / max};
}

// The most present hue among the coloured pixels; a grey or one-colour symbolic icon has none.
function dominant(pixbuf) {
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const alpha = pixbuf.get_has_alpha();
    const bins = Array.from({length: HUES}, () => ({weight: 0, r: 0, g: 0, b: 0}));
    for (let y = 0; y < pixbuf.get_height(); y++) {
        const row = y * pixbuf.get_rowstride();
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const at = row + x * channels;
            if (alpha && pixels[at + 3] < MIN_ALPHA)
                continue;
            const [r, g, b] = [pixels[at], pixels[at + 1], pixels[at + 2]];
            const {hue, saturation} = hsv(r, g, b);
            if (saturation < MIN_SATURATION)
                continue;
            const bin = bins[Math.min(HUES - 1, Math.floor(hue * HUES))];
            bin.weight += saturation;
            bin.r += r * saturation;
            bin.g += g * saturation;
            bin.b += b * saturation;
        }
    }
    const best = bins.reduce((a, b) => (b.weight > a.weight ? b : a));
    if (!best.weight)
        return null;
    return [best.r, best.g, best.b].map(v => Math.round(v / best.weight));
}

function iconColor(app) {
    try {
        const info = new St.IconTheme().lookup_by_gicon(app.get_icon(), SAMPLE, St.IconLookupFlags.FORCE_SIZE);
        const pixbuf = info?.load_icon();
        return pixbuf ? dominant(pixbuf) : null;
    } catch (e) {
        logError(e, 'João: color del icono');
        return null;
    }
}

function accentColor() {
    const name = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('accent-color');
    return ACCENT[name] ?? ACCENT.blue;
}

export function appColor(notification) {
    const {source} = notification;
    if (isChat(source))
        return CHAT_COLOR;
    const app = source?.app;
    if (!app)
        return SYSTEM_COLOR;
    const id = app.get_id();
    if (!cache.has(id))
        cache.set(id, iconColor(app));
    return cache.get(id) ?? accentColor();
}

// Nothing kept once João goes off.
export function forgetColors() {
    cache.clear();
}

export const rgb = ([r, g, b], alpha = 1) => `rgba(${r}, ${g}, ${b}, ${alpha})`;

// GNOME does not say which notifications are messages: the app does, by what it is.
function isMessage(source) {
    if (isChat(source))
        return true;
    const categories = source?.app?.get_app_info()?.get_categories() ?? '';
    return categories.split(';').some(c => c === 'InstantMessaging' || c === 'Chat');
}

function shorten(text) {
    const letters = [...text.replace(/\s+/g, ' ').trim()];
    return letters.length > CAPTION_MAX ? `${letters.slice(0, CAPTION_MAX - 1).join('').trimEnd()}…` : letters.join('');
}

export function captionOf(notification, hideMessageText) {
    const name = sourceName(notification.source);
    const title = (notification.title ?? '').trim();
    if (hideMessageText && isMessage(notification.source) && title && title !== name)
        return shorten(`${title} · nuevo mensaje`);
    const summary = !title || title === name ? plainBody(notification) || title : title;
    return shorten(name && summary !== name ? `${name} · ${summary}` : summary || name);
}
