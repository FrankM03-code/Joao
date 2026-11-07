// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// A small JSON file in ~/.local/share/joao, read and written without blocking the shell. Changes
// close together are written once, half a second after the last one. A damaged file is kept as
// <name>.bak and the data starts empty: nothing is ever deleted.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SAVE_DELAY = 500;

export class JsonFile {
    // name: the file in ~/.local/share/joao. accept(data): the data read, or null when it is not valid.
    constructor(name, accept) {
        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'joao']);
        this._file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, name]));
        this._accept = accept;
        this._saveId = 0;
        this._pending = null;
        this._generation = 0;
        this._writing = 0;
        this._cancellable = new Gio.Cancellable();
    }

    get path() {
        return this._file.get_path();
    }

    // Calls back with the data, or null when there is no file yet or it was damaged. Nothing is
    // read while a write is waiting or going on, and what was read is dropped if something changed
    // meanwhile.
    load(done) {
        if (this._pending || this._writing)
            return;
        const generation = this._generation;
        this._file.load_contents_async(this._cancellable, (file, result) => {
            let data = null;
            try {
                const [, bytes] = file.load_contents_finish(result);
                data = this._accept(JSON.parse(new TextDecoder().decode(bytes)));
                if (!data)
                    this._keepDamaged();
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    this._keepDamaged();
            }
            if (generation === this._generation && !this._pending && !this._writing)
                done(data);
        });
    }

    _keepDamaged() {
        const backup = Gio.File.new_for_path(`${this.path}.bak`);
        this._file.copy_async(backup, Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, null, null, (file, result) => {
            try {
                file.copy_finish(result);
            } catch (e) {
                console.warn(`João: no se pudo guardar la copia de ${this.path}: ${e.message}`);
            }
        });
    }

    // Writes data soon; the latest data wins.
    save(data) {
        this._generation++;
        this._pending = data;
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY, () => {
            this._saveId = 0;
            this._write();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Writes now what is waiting, if anything (on the way out).
    flush() {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = 0;
        this._write();
    }

    _write() {
        if (!this._pending)
            return;
        const text = `${JSON.stringify(this._pending, null, 1)}\n`;
        this._pending = null;
        GLib.mkdir_with_parents(this._dir, 0o700);
        const bytes = new GLib.Bytes(new TextEncoder().encode(text));
        this._writing++;
        this._file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null, (file, result) => {
            this._writing--;
            try {
                file.replace_contents_finish(result);
            } catch (e) {
                console.warn(`João: no se pudo guardar ${this.path}: ${e.message}`);
            }
        });
    }

    // The pending write still goes out; only reads are cancelled.
    destroy() {
        this.flush();
        this._cancellable.cancel();
    }
}
