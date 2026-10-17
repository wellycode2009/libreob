import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const COLORS = [
    '#fff2a8', // yellow
    '#ffc9d6', // pink
    '#bfe3ff', // blue
    '#c8f0c0', // green
    '#ffd9a8', // orange
    '#e1cfff', // purple
    '#ffffff', // white
];

const IMAGE_EXT = {png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif', bmp: 'bmp'};

function randomTilt() {
    return +(Math.random() * 5 - 2.5).toFixed(2); // every card hangs a little crooked
}

function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function rmrf(file) {
    try {
        const type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        if (type === Gio.FileType.DIRECTORY) {
            const en = file.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let info;
            while ((info = en.next_file(null)))
                rmrf(en.get_child(info));
            en.close(null);
        }
        file.delete(null);
    } catch (_e) {
        // already gone
    }
}

/**
 * Everything lives in ~/.local/share/libreob:
 *   board.json       the list of notes / images / files
 *   files/<id>/<name>  copies of pinned images and files
 */
export class Store {
    constructor() {
        this.dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'libreob']);
        this.filesDir = GLib.build_filenamev([this.dir, 'files']);
        this.dataPath = GLib.build_filenamev([this.dir, 'board.json']);
        GLib.mkdir_with_parents(this.filesDir, 0o755);

        this.items = [];
        this._saveId = 0;
        this._cancellable = new Gio.Cancellable();
        this._load();
    }

    _load() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this.dataPath);
            if (!ok)
                return;
            const data = JSON.parse(new TextDecoder().decode(bytes));
            if (Array.isArray(data.items))
                this.items = data.items;
            for (const item of this.items) {
                if (item.tilt === undefined)
                    item.tilt = randomTilt();
            }
        } catch (_e) {
            // first run, or unreadable file: start with an empty board
        }
    }

    save() {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._saveId = 0;
            this.flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    flush() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
        try {
            GLib.file_set_contents(this.dataPath,
                JSON.stringify({version: 1, items: this.items}, null, 2));
        } catch (e) {
            logError(e, 'libreob: could not save board');
        }
    }

    pathFor(item) {
        return GLib.build_filenamev([this.filesDir, item.file]);
    }

    addNote(text = '') {
        const item = {
            id: newId(),
            type: 'note',
            text,
            color: COLORS[this.items.length % 6],
            created: Date.now(),
            tilt: randomTilt(),
        };
        this.items.unshift(item);
        this.save();
        return item;
    }

    /** Pin raw image bytes (e.g. a screenshot from the clipboard). */
    addImageData(data, mime) {
        const id = newId();
        const ext = IMAGE_EXT[mime.split('/')[1]] ?? 'png';
        const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H.%M.%S');
        const name = `Image ${stamp}.${ext}`;
        GLib.mkdir_with_parents(GLib.build_filenamev([this.filesDir, id]), 0o755);
        GLib.file_set_contents(GLib.build_filenamev([this.filesDir, id, name]), data);

        const item = {
            id,
            type: 'image',
            name,
            file: `${id}/${name}`,
            mime,
            size: data.length,
            color: '#ffffff',
            created: Date.now(),
            tilt: randomTilt(),
        };
        this.items.unshift(item);
        this.save();
        return item;
    }

    /** Copy a file into the board. Calls done(item) or done(null) on failure. */
    addFile(file, done) {
        let info;
        try {
            info = file.query_info('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE, null);
        } catch (_e) {
            done(null);
            return;
        }
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            done(null);
            return;
        }

        const id = newId();
        const name = file.get_basename();
        const [ctype] = Gio.content_type_guess(name, null);
        const dirPath = GLib.build_filenamev([this.filesDir, id]);
        GLib.mkdir_with_parents(dirPath, 0o755);
        const dest = Gio.File.new_for_path(GLib.build_filenamev([dirPath, name]));

        file.copy_async(dest, Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT,
            this._cancellable, null, (src, res) => {
                try {
                    src.copy_finish(res);
                } catch (_e) {
                    rmrf(Gio.File.new_for_path(dirPath));
                    done(null);
                    return;
                }
                const isImage = ctype.startsWith('image/');
                const item = {
                    id,
                    type: isImage ? 'image' : 'file',
                    name,
                    file: `${id}/${name}`,
                    mime: ctype,
                    size: info.get_size(),
                    color: isImage ? '#ffffff' : COLORS[2],
                    created: Date.now(),
            tilt: randomTilt(),
                };
                this.items.unshift(item);
                this.save();
                done(item);
            });
    }

    remove(id) {
        const idx = this.items.findIndex(i => i.id === id);
        if (idx < 0)
            return;
        const [item] = this.items.splice(idx, 1);
        if (item.type !== 'note')
            rmrf(Gio.File.new_for_path(GLib.build_filenamev([this.filesDir, item.id])));
        this.flush();
    }

    destroy() {
        this._cancellable.cancel();
        this.flush();
    }
}
