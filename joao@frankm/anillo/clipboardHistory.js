// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What was copied lately: the last 25, plus those pinned (they do not count). Kept in
// ~/.local/share/joao/clipboard.json, images as files in ~/.cache/joao/clips. Nothing marked as a
// password by its app is kept (KeePassXC and others mark it with x-kde-passwordManagerHint); an
// app that does not mark them cannot be told apart. Key clipboard-history.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {JsonFile} from '../sistema/jsonFile.js';

const VERSION = 1;
const RECENT = 25;
const TERMINALS = /terminal|ptyxis|konsole|console|kitty|alacritty|tilix|wezterm|foot|xterm|guake|tilda|blackbox/i;
const MAX_TEXT = 100000;
const SECRET = /x-kde-passwordManagerHint|application\/x-secret|password/i;
const IMAGE = 'image/png';
const CB = St.ClipboardType.CLIPBOARD;

const now = () => Math.floor(GLib.get_real_time() / 1e6);

// What a text is: a colour, a link, a command or just text.
export function kindOf(text) {
    const t = text.trim();
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t))
        return 'color';
    if (/^(?:https?|ftp):\/\/\S+$/i.test(t) || /^www\.\S+\.\S+$/i.test(t))
        return 'link';
    if (!t.includes('\n') && /^(?:\$ |sudo |git |cd |ls\b|npm |npx |flatpak |gnome-|cat |echo |grep |find |cp |mv |rm |mkdir |chmod |systemctl |journalctl |dnf |apt |pip |python3? |\.\/)/.test(t))
        return 'command';
    return 'text';
}

export const KIND_NAMES = {text: 'Texto', command: 'Comando', color: 'Color', link: 'Enlace', image: 'Imagen'};

export const ClipboardHistory = GObject.registerClass({
    Signals: {changed: {}},
}, class JoaoClipboardHistory extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._items = [];
        this._ownText = null;   // what João itself just put there: not a new copy
        this._ownImage = null;
        this._clipsDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'joao', 'clips']);
        this._file = new JsonFile('clipboard.json', data =>
            (data?.version === VERSION && Array.isArray(data.items) ? data : null));
        this._file.load(data => {
            this._items = (data?.items ?? []).filter(i => i && typeof i.id === 'string');
            this.emit('changed');
        });
        this._selection = global.display.get_selection();
        this._ownerId = this._selection.connect('owner-changed', (selection, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._capture();
        });
        this._settingId = settings.connect('changed::clipboard-history', () => {
            // Off: the recent ones go away now; the pinned ones were chosen and stay.
            if (!this.enabled)
                this.clearRecent();
            this.emit('changed');
        });
    }

    get enabled() {
        return this._settings.get_boolean('clipboard-history');
    }

    get pinned() {
        return this._items.filter(i => i.pinned);
    }

    get recent() {
        return this._items.filter(i => !i.pinned);
    }

    get count() {
        return this._items.length;
    }

    _capture() {
        if (!this.enabled)
            return;
        const clipboard = St.Clipboard.get_default();
        const types = clipboard.get_mimetypes(CB) ?? [];
        if (!types.length || types.some(t => SECRET.test(t)))
            return;
        const app = Shell.WindowTracker.get_default().focus_app?.get_name() ?? '';
        const textual = types.some(t => t.startsWith('text/') || t === 'UTF8_STRING' || t === 'STRING');
        if (types.includes(IMAGE) && !textual) {
            clipboard.get_content(CB, IMAGE, (c, bytes) => this._addImage(bytes, app));
            return;
        }
        clipboard.get_text(CB, (c, text) => this._addText(text, app));
    }

    _addText(text, app) {
        if (!text || !text.trim() || text.length > MAX_TEXT)
            return;
        if (text === this._ownText) {
            this._ownText = null;
            return;
        }
        this._ownText = null;
        const old = this._items.find(i => i.kind !== 'image' && i.text === text);
        if (old) {
            this._toTop(old, app);
            return;
        }
        // From a terminal, a one-line copy is a command.
        let kind = kindOf(text);
        if (kind === 'text' && TERMINALS.test(app) && !text.trim().includes('\n'))
            kind = 'command';
        this._add({id: GLib.uuid_string_random(), kind, text, app, time: now(), pinned: false});
    }

    _addImage(bytes, app) {
        const size = bytes?.get_size?.() ?? 0;
        if (!size)
            return;
        const sum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA1, bytes);
        if (sum === this._ownImage) {
            this._ownImage = null;
            return;
        }
        this._ownImage = null;
        const old = this._items.find(i => i.kind === 'image' && i.sum === sum);
        if (old) {
            this._toTop(old, app);
            return;
        }
        const path = GLib.build_filenamev([this._clipsDir, `${sum}.png`]);
        GLib.mkdir_with_parents(this._clipsDir, 0o700);
        Gio.File.new_for_path(path).replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null, (file, result) => {
            try {
                file.replace_contents_finish(result);
                this._add({id: GLib.uuid_string_random(), kind: 'image', text: 'Imagen', file: path, sum, app, time: now(), pinned: false});
            } catch (e) {
                console.warn(`João: no se pudo guardar la imagen copiada: ${e.message}`);
            }
        });
    }

    _toTop(item, app) {
        this._items = [item, ...this._items.filter(i => i !== item)];
        item.time = now();
        item.app = app || item.app;
        this._changed();
    }

    _add(item) {
        this._items.unshift(item);
        const recent = this.recent;
        for (const gone of recent.slice(RECENT))
            this._drop(gone);
        this._changed();
    }

    _drop(item) {
        this._items = this._items.filter(i => i !== item);
        if (item.file && !this._items.some(i => i.file === item.file)) {
            Gio.File.new_for_path(item.file).delete_async(GLib.PRIORITY_DEFAULT, null, (file, result) => {
                try {
                    file.delete_finish(result);
                } catch {}
            });
        }
    }

    // Puts it back on the clipboard; pasting is up to the user.
    copy(item) {
        const clipboard = St.Clipboard.get_default();
        if (item.kind !== 'image') {
            this._ownText = item.text;
            clipboard.set_text(CB, item.text);
            return;
        }
        Gio.File.new_for_path(item.file).load_contents_async(null, (file, result) => {
            try {
                const [, data] = file.load_contents_finish(result);
                const bytes = new GLib.Bytes(data);
                this._ownImage = item.sum;
                clipboard.set_content(CB, IMAGE, bytes);
            } catch (e) {
                console.warn(`João: no se pudo copiar la imagen: ${e.message}`);
            }
        });
    }

    togglePin(item) {
        item.pinned = !item.pinned;
        // Unpinned, it is a recent one again, and the oldest may have to go.
        for (const gone of this.recent.slice(RECENT))
            this._drop(gone);
        this._changed();
    }

    remove(item) {
        this._drop(item);
        this._changed();
    }

    clearRecent() {
        this.recent.forEach(item => this._drop(item));
        this._changed();
    }

    _changed() {
        this._file.save({version: VERSION, items: this._items});
        this.emit('changed');
    }

    destroy() {
        this._selection.disconnect(this._ownerId);
        this._settings.disconnect(this._settingId);
        this._file.destroy();
    }
});
