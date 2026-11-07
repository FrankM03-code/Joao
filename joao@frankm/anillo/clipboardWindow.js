// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The clipboard (docs/herramientas-ampliadas-spec.md): a search box (it has the keyboard), filters
// (Todo · Texto · Enlaces · Colores · Imágenes) and one line per copy, pinned ones first. A click
// or Enter copies one (✓ Copiado) and the card goes back to the scenes; pasting is up to the
// user. Right click: pin or delete. "Borrar" asks again in the same line before clearing the
// recent ones.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {animations, ChoiceMenu, header, Popup, scaleFactor} from './popup.js';

const STAGGER = 35;
const ENTER = 350;
const SHIFT = 6;
const COPIED = 900;
const ICONS = {text: 'format-justify-left-symbolic', command: 'utilities-terminal-symbolic', link: 'insert-link-symbolic'};
const FILTERS = [
    ['all', 'Todo', () => true],
    ['text', 'Texto', item => item.kind === 'text' || item.kind === 'command'],
    ['link', 'Enlaces', item => item.kind === 'link'],
    ['color', 'Colores', item => item.kind === 'color'],
    ['image', 'Imágenes', item => item.kind === 'image'],
];

// One line of what was copied: its first line, a link's domain.
function shown(item) {
    if (item.kind === 'image')
        return 'Imagen';
    const first = item.text.trim().split('\n')[0];
    if (item.kind === 'link') {
        try {
            return GLib.Uri.parse(/^www\./i.test(first) ? `https://${first}` : first, GLib.UriFlags.NONE).get_host() ?? first;
        } catch {
            return first;
        }
    }
    return first;
}

// "ahora", "3 min", "2 h", "4 d"; "fijado" for the pinned ones.
function age(item) {
    if (item.pinned)
        return 'fijado';
    const seconds = Math.max(0, Math.floor(GLib.get_real_time() / 1e6) - (item.time ?? 0));
    if (seconds < 60)
        return 'ahora';
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)} min`;
    if (seconds < 86400)
        return `${Math.floor(seconds / 3600)} h`;
    return `${Math.floor(seconds / 86400)} d`;
}

export const ClipboardWindow = GObject.registerClass(
class JoaoClipboardWindow extends Popup {
    // done(): copied, the card may go back to the scenes.
    _init({history, back, done, layer}) {
        super._init({style_class: 'joao-ring-tool joao-clip-window', y_expand: true});
        this._history = history;
        this._done = done;
        this._layer = layer;
        this._filter = 'all';
        this.back = back;

        const right = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._count = new St.Label({style_class: 'joao-ring-head-hint', y_align: Clutter.ActorAlign.CENTER});
        right.add_child(this._count);
        this._clear = new St.Button({style_class: 'joao-ring-link', label: 'Borrar', can_focus: true,
            accessible_name: 'Borrar las copias recientes', y_align: Clutter.ActorAlign.CENTER});
        this._clear.connect('clicked', () => this._askClear());
        right.add_child(this._clear);
        this._confirm = new St.BoxLayout({style_class: 'joao-clip-confirm', visible: false, y_align: Clutter.ActorAlign.CENTER});
        this._confirm.add_child(new St.Label({style_class: 'joao-clip-confirm-text', text: '¿Borrar las recientes?', y_align: Clutter.ActorAlign.CENTER}));
        const yes = new St.Button({style_class: 'joao-ring-link strong', label: 'Sí', can_focus: true, accessible_name: 'Sí, borrar las recientes'});
        yes.connect('clicked', () => {
            this._history.clearRecent();
            this._endConfirm();
        });
        const no = new St.Button({style_class: 'joao-ring-link', label: 'No', can_focus: true});
        no.connect('clicked', () => this._endConfirm());
        this._confirm.add_child(yes);
        this._confirm.add_child(no);
        right.add_child(this._confirm);
        this.add_child(header('Portapapeles', back, right));

        const search = new St.BoxLayout({style_class: 'joao-clip-search', x_expand: true});
        search.add_child(new St.Icon({icon_name: 'system-search-symbolic', style_class: 'joao-clip-search-icon', y_align: Clutter.ActorAlign.CENTER}));
        this.entry = new St.Entry({style_class: 'joao-clip-entry', hint_text: 'Buscar en copias', can_focus: true, x_expand: true});
        this.entry.clutter_text.connect('text-changed', () => this._fill(false));
        // Enter copies the first one found; Down goes to the list.
        this.entry.clutter_text.connect('activate', () => this.rows[0] && this._copy(this.rows[0]));
        this.entry.clutter_text.connect('key-press-event', (actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Down || !this.rows.length)
                return Clutter.EVENT_PROPAGATE;
            this.rows[0].grab_key_focus();
            return Clutter.EVENT_STOP;
        });
        search.add_child(this.entry);
        this.add_child(search);

        const filters = new St.BoxLayout({style_class: 'joao-clip-filters', x_expand: true});
        this.filters = FILTERS.map(([id, name]) => {
            const pill = new St.Button({style_class: 'joao-clip-filter', label: name, can_focus: true,
                accessible_name: `Mostrar: ${name}`});
            pill.filterId = id;
            pill.connect('clicked', () => this.setFilter(id));
            filters.add_child(pill);
            return pill;
        });
        this.add_child(filters);

        this._list = new St.BoxLayout({style_class: 'joao-clip-list', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._scroll = new St.ScrollView({style_class: 'joao-clip-scroll', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true, x_expand: true, y_expand: true, child: this._list});
        this.add_child(this._scroll);
        this.rows = [];
        history.connectObject('changed', () => this._fill(false), this);
        this.connect('destroy', () => {
            history.disconnectObject(this);
            if (this._copiedId)
                GLib.source_remove(this._copiedId);
            this._copiedId = 0;
            this._menu?.destroy();
        });
        this.connect('key-press-event', (actor, event) => this._onKey(event));
        this._syncFilters();
        this._fill(false);
    }

    enter(animate) {
        this.focus();
        this._fill(animate);
    }

    focus() {
        this.entry.grab_key_focus();
    }

    setFilter(id) {
        this._filter = id;
        this._syncFilters();
        this._fill(false);
    }

    _syncFilters() {
        this.filters.forEach(pill => {
            if (pill.filterId === this._filter)
                pill.add_style_pseudo_class('checked');
            else
                pill.remove_style_pseudo_class('checked');
        });
    }

    _fill(animate) {
        this._menu?.destroy();
        this._menu = null;
        const query = this.entry.text.trim().toLowerCase();
        const [, , kind] = FILTERS.find(([id]) => id === this._filter);
        const match = item => kind(item) && (!query || (item.kind !== 'image' && item.text.toLowerCase().includes(query)) ||
            (item.app ?? '').toLowerCase().includes(query));
        const items = [...this._history.pinned, ...this._history.recent].filter(match);
        this._list.destroy_all_children();
        this.rows = items.map(item => {
            const row = this._row(item);
            this._list.add_child(row);
            return row;
        });
        if (!this.rows.length) {
            let text = query || this._filter !== 'all' ? 'Nada coincide' : 'Todavía no has copiado nada';
            if (!this._history.enabled && !this._history.pinned.length)
                text = 'El historial está apagado en Preferencias';
            this._list.add_child(new St.Label({style_class: 'joao-clip-empty', text}));
        }
        const count = this._history.count;
        const clearable = this._history.recent.length > 0 && !this._confirm.visible;
        this._count.text = `${count === 1 ? '1 copia' : `${count} copias`}${clearable ? ' · ' : ''}`;
        this._count.visible = count > 0 && !this._confirm.visible;
        this._clear.visible = clearable;
        if (!animate || !animations())
            return;
        this.rows.forEach((row, i) => {
            row.set({opacity: 0, translation_y: SHIFT * scaleFactor()});
            row.ease({opacity: 255, translation_y: 0, delay: i * STAGGER, duration: ENTER,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT});
        });
    }

    _row(item) {
        const row = new St.Button({style_class: 'joao-clip-row', can_focus: true, x_expand: true,
            accessible_name: `${shown(item)}, ${age(item)}. Clic para copiar`});
        row.item = item;
        const box = new St.BoxLayout({style_class: 'joao-clip-row-box', x_expand: true});
        box.add_child(this._thumb(item));
        const main = new St.Label({style_class: 'joao-clip-text', text: shown(item), x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        main.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        if (item.kind === 'command' || item.kind === 'color')
            main.add_style_class_name('mono');
        box.add_child(main);
        row.age = new St.Label({style_class: 'joao-clip-age', text: age(item), y_align: Clutter.ActorAlign.CENTER});
        box.add_child(row.age);
        row.ok = new St.Label({style_class: 'joao-clip-ok', text: '✓ Copiado', visible: false, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(row.ok);
        row.set_child(box);
        row.connect('clicked', () => this._copy(row));
        row.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this._choices(row, event.get_coords());
            return Clutter.EVENT_STOP;
        });
        return row;
    }

    _thumb(item) {
        const thumb = new St.Bin({style_class: 'joao-clip-thumb', y_align: Clutter.ActorAlign.CENTER});
        if (item.kind === 'color') {
            thumb.style = `background-color: ${item.text.trim()};`;
        } else if (item.kind === 'image' && item.file) {
            thumb.style = `background-image: url("file://${item.file}"); background-size: cover;`;
        } else {
            thumb.set_child(new St.Icon({icon_name: item.pinned ? 'view-pin-symbolic' : ICONS[item.kind] ?? ICONS.text}));
        }
        return thumb;
    }

    _copy(row) {
        if (this._copying)
            return;
        this._copying = true;
        this._history.copy(row.item);
        row.age.hide();
        row.ok.show();
        row.ok.opacity = 0;
        row.ok.ease({opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._copiedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COPIED, () => {
            this._copiedId = 0;
            this._done();
            return GLib.SOURCE_REMOVE;
        });
    }

    _choices(row, [x, y]) {
        this._menu?.destroy();
        const item = row.item;
        this._menu = new ChoiceMenu([
            [item.pinned ? 'Desfijar' : 'Fijar', () => this._history.togglePin(item)],
            ['Eliminar', () => this._history.remove(item)],
        ], () => {
            this._menu = null;
        });
        this._menu.showAt(this._layer, x, y);
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        const index = this.rows.findIndex(r => r.has_key_focus());
        if (index < 0)
            return Clutter.EVENT_PROPAGATE;
        if (key === Clutter.KEY_Up) {
            if (index === 0)
                this.entry.grab_key_focus();
            else
                this.rows[index - 1].grab_key_focus();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Down) {
            this.rows[Math.min(index + 1, this.rows.length - 1)].grab_key_focus();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Delete) {
            this._history.remove(this.rows[index].item);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _askClear() {
        this._clear.hide();
        this._count.hide();
        this._confirm.show();
        this._confirm.get_child_at_index(1).grab_key_focus();
    }

    _endConfirm() {
        this._confirm.hide();
        this._fill(false);
        this.focus();
    }
});
