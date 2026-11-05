// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What the island shows of a notification: the pill and the card. The look is in stylesheet.css.
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {formatTimeSpan} from 'resource:///org/gnome/shell/misc/dateUtils.js';

import {RoundedCorners} from '../franja/sceneThumbnail.js';
import {plainBody} from '../sistema/notifications.js';
import {hasPreview, sourceIcon, sourceName} from './sourceLook.js';

export const PILL_MAX = 360;
const CARD_WIDTH = 380;
const CARD_PADDING = 16;
const PREVIEW_HEIGHT = 134;
const PREVIEW_RADIUS = 16;
const PREVIEW_MIN = 96;     // smaller than this, an image is an icon
const MAX_ACTIONS = 3;
const BODY_LINES = 4;
const BODY_LINE_HEIGHT = 1.45;

const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

// Its size, if the notification's icon is really a picture (a screenshot, a photo).
function pictureSize(gicon) {
    if (!gicon || gicon instanceof Gio.ThemedIcon)
        return null;
    let size = null;
    try {
        if (gicon instanceof St.ImageContent) {
            const [, width, height] = gicon.get_preferred_size();
            size = {width, height};
        } else if (gicon instanceof GdkPixbuf.Pixbuf) {
            size = {width: gicon.width, height: gicon.height};
        } else if (gicon instanceof Gio.FileIcon) {
            const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info(gicon.file.get_path());
            size = format ? {width, height} : null;
        } else if (gicon instanceof Gio.BytesIcon) {
            const stream = Gio.MemoryInputStream.new_from_bytes(gicon.get_bytes());
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
            size = {width: pixbuf.width, height: pixbuf.height};
        }
    } catch {
        return null;
    }
    return size && Math.max(size.width, size.height) >= PREVIEW_MIN ? size : null;
}

// A picture goes in the preview, and the icon is the app's.
const previewOf = notification => (hasPreview(notification.source) && pictureSize(notification.gicon) ? notification.gicon : null);
const iconOf = notification => (previewOf(notification) ? null : notification.gicon) ?? sourceIcon(notification);

function label(style, text, {wrap = false} = {}) {
    const actor = new St.Label({style_class: style, text: text ?? ''});
    if (wrap) {
        actor.clutter_text.line_wrap = true;
        actor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    }
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

export const PillContent = GObject.registerClass(
class JoaoIslandPill extends St.Button {
    _init() {
        super._init({style_class: 'joao-island-pill', can_focus: false, x_expand: true, y_expand: true, reactive: true});
        const layer = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this.set_child(layer);
        this._box = new St.BoxLayout({style_class: 'joao-island-pill-box', x_expand: true, y_expand: true});
        this._icon = new St.Icon({icon_size: 20, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(new St.Bin({style_class: 'joao-island-pill-icon', y_align: Clutter.ActorAlign.CENTER, child: this._icon}));
        this._text = label('joao-island-pill-text', '');
        this._text.y_align = Clutter.ActorAlign.CENTER;
        this._text.x_expand = true;
        this._box.add_child(this._text);
        this._more = new St.Label({style_class: 'joao-island-pill-more', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._box.add_child(this._more);
        layer.add_child(this._box);

        this._track = new St.Widget({
            style_class: 'joao-island-track',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.END,
            layout_manager: new Clutter.BinLayout(),
        });
        this._fill = new St.Widget({style_class: 'joao-island-fill', x_expand: true});
        this._fill.set_pivot_point(1, 0.5);
        this._track.add_child(this._fill);
        layer.add_child(this._track);
    }

    fill(notification, more) {
        const gicon = iconOf(notification);
        if (gicon)
            this._icon.gicon = gicon;
        else
            this._icon.icon_name = 'preferences-system-notifications-symbolic';
        this._text.text = notification.title || plainBody(notification) || sourceName(notification.source);
        this._more.text = `+${more}`;
        this._more.visible = more > 0;
    }

    // The width it wants, at most PILL_MAX.
    get wantedWidth() {
        const [, natural] = this._box.get_preferred_width(-1);
        return Math.min(Math.ceil(natural), PILL_MAX * scaleFactor());
    }

    // @ms: how long the line takes to empty from @total. 0: an urgent one, no line.
    runLine(ms, total) {
        this._fill.remove_all_transitions();
        this._track.visible = ms > 0;
        if (ms <= 0)
            return;
        this._fill.scale_x = Math.min(1, ms / total);
        this._fill.ease({scale_x: 0, duration: ms, mode: Clutter.AnimationMode.LINEAR});
    }

    stopLine() {
        this._fill.remove_all_transitions();
    }
});

export const CardContent = GObject.registerClass({
    Signals: {
        'close-clicked': {},
        'action-done': {},
    },
}, class JoaoIslandCard extends St.Button {
    _init() {
        super._init({style_class: 'joao-island-card', can_focus: true, reactive: true, x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START});
        this._box = new St.BoxLayout({style_class: 'joao-island-card-box', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.set_child(this._box);

        const head = new St.BoxLayout({style_class: 'joao-island-card-head', x_expand: true});
        this._icon = new St.Icon({icon_size: 24, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        head.add_child(new St.Bin({style_class: 'joao-island-card-icon', y_align: Clutter.ActorAlign.CENTER, child: this._icon}));
        const words = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = label('joao-island-card-title', '');
        this._meta = label('joao-island-card-meta', '');
        words.add_child(this._title);
        words.add_child(this._meta);
        head.add_child(words);
        const close = new St.Button({
            style_class: 'joao-island-close',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Descartar la notificación',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
        });
        close.connect('clicked', () => this.emit('close-clicked'));
        head.add_child(close);
        this._box.add_child(head);

        this._preview = new St.Widget({clip_to_allocation: true, visible: false, x_expand: true});
        this._box.add_child(this._preview);
        this._bodyLabel = label('joao-island-card-body', '', {wrap: true});
        this._box.add_child(this._bodyLabel);
        this._actions = new St.BoxLayout({style_class: 'joao-island-actions', x_expand: true, visible: false});
        this._actions.get_layout_manager().homogeneous = true;
        this._box.add_child(this._actions);
    }

    fill(notification) {
        const gicon = iconOf(notification);
        if (gicon)
            this._icon.gicon = gicon;
        else
            this._icon.icon_name = 'preferences-system-notifications-symbolic';
        this._title.text = notification.title ?? '';
        const when = notification.datetime ? ` · ${formatTimeSpan(notification.datetime)}` : '';
        this._meta.text = `${sourceName(notification.source)}${when}`;
        this._fillPreview(previewOf(notification));
        this._bodyText = plainBody(notification);
        this._fillActions(notification);
        this.accessible_name = `${sourceName(notification.source)}: ${notification.title ?? ''}`;
    }

    _fillPreview(gicon) {
        this._preview.destroy_all_children();
        this._preview.clear_effects();
        const size = pictureSize(gicon);
        this._preview.visible = !!size;
        if (!size)
            return;
        const scale = scaleFactor();
        const width = (CARD_WIDTH - 2 * CARD_PADDING) * scale;
        const height = PREVIEW_HEIGHT * scale;
        // Covers the box, like object-fit: cover. St.Icon fits the picture in a square.
        const cover = Math.max(width / size.width, height / size.height);
        const side = Math.ceil(Math.max(size.width, size.height) * cover);
        const picture = new St.Icon({gicon, icon_size: Math.ceil(side / scale)});
        picture.set_position(Math.round((width - side) / 2), Math.round((height - side) / 2));
        this._preview.set_size(width, height);
        this._preview.add_child(picture);
        this._preview.add_effect(new RoundedCorners(width, height, PREVIEW_RADIUS * scale));
    }

    // Line spacing has no CSS in St; a label wraps and ends in "…" only with a height to fit in.
    fit() {
        const text = this._bodyText;
        this._bodyLabel.visible = text !== '';
        this._bodyLabel.height = -1;
        if (!text)
            return;
        const clutterText = this._bodyLabel.clutter_text;
        const inner = (CARD_WIDTH - 2 * CARD_PADDING) * scaleFactor();
        const measure = words => {
            clutterText.set_markup(`<span line_height="${BODY_LINE_HEIGHT}">${GLib.markup_escape_text(words, -1)}</span>`);
            return this._bodyLabel.get_preferred_height(inner)[1];
        };
        const line = measure('x');
        const all = measure(text);
        if (all > line * BODY_LINES + 1)
            this._bodyLabel.height = Math.ceil(line * BODY_LINES);
    }

    _fillActions(notification) {
        this._actions.destroy_all_children();
        const actions = notification.actions.slice(0, MAX_ACTIONS);
        this._actions.visible = actions.length > 0;
        actions.forEach((action, i) => {
            const button = new St.Button({
                style_class: `joao-island-action${i === 0 ? ' primary' : ''}`,
                can_focus: true,
                x_expand: true,
                label: action.label,
            });
            button.get_child()?.clutter_text?.set_ellipsize(Pango.EllipsizeMode.END);
            button.connect('clicked', () => {
                action.activate();
                this.emit('action-done');
            });
            this._actions.add_child(button);
        });
    }

    // Its height for the card's fixed width: what the island grows to, with no gap below.
    get wantedHeight() {
        return Math.ceil(this.get_preferred_height(CARD_WIDTH * scaleFactor())[1]);
    }
});
