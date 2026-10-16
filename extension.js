import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {Store, COLORS} from './store.js';

const COLS = 3;
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];

function decode(bytes) {
    const data = bytes?.get_data();
    return data ? new TextDecoder().decode(data) : '';
}

function vAdjustment(scroll) {
    return scroll.vadjustment ?? scroll.get_vscroll_bar?.()?.adjustment ?? scroll.vscroll?.adjustment ?? null;
}

const Indicator = GObject.registerClass(
class LibreobIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'libreob', false);

        this._ext = ext;
        this._store = new Store();
        this._cancellable = new Gio.Cancellable();
        this._sources = new Set();
        this._entries = new Map();
        this._focusId = null;
        this._proc = null;

        this.add_child(new St.Icon({
            icon_name: 'view-pin-symbolic',
            style_class: 'system-status-icon',
        }));

        this.menu.actor.add_style_class_name('libreob-menu');
        this._buildBoard();

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._rebuild();
            else
                this._store.flush();
        });
        this.menu.actor.connect('key-press-event', this._onKey.bind(this));
    }

    // ---------------------------------------------------------------- layout

    _buildBoard() {
        this._board = new St.BoxLayout({vertical: true, style_class: 'libreob-board'});

        const header = new St.BoxLayout({style_class: 'libreob-header'});
        header.add_child(new St.Label({
            text: 'libreob',
            style_class: 'libreob-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        header.add_child(this._makeButton('list-add-symbolic', 'Note', () => this._addNote()));
        header.add_child(this._makeButton('mail-attachment-symbolic', 'Image / file', () => this._pickFiles()));
        header.add_child(this._makeButton('edit-paste-symbolic', 'Paste', () => this._paste()));

        this._scroll = new St.ScrollView({
            style_class: 'libreob-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._rows = new St.BoxLayout({vertical: true, style_class: 'libreob-rows'});
        this._scroll.set_child(this._rows);

        this._board.add_child(header);
        this._board.add_child(this._scroll);
        this.menu.box.add_child(this._board);
    }

    _makeButton(iconName, label, cb) {
        const btn = new St.Button({
            style_class: 'libreob-btn',
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        const box = new St.BoxLayout({style_class: 'libreob-btn-box'});
        box.add_child(new St.Icon({icon_name: iconName, icon_size: 16}));
        box.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
        btn.set_child(box);
        btn.connect('clicked', cb);
        return btn;
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._sources.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
    }

    _rebuild() {
        this._entries.clear();
        this._rows.destroy_all_children();

        const items = this._store.items;
        if (items.length === 0) {
            this._rows.add_child(new St.Label({
                style_class: 'libreob-empty',
                text: 'Nothing pinned yet.\nAdd a note, pick an image or file,\nor press Ctrl+V to paste one.',
            }));
            return;
        }

        for (let i = 0; i < items.length; i += COLS) {
            const row = new St.BoxLayout({style_class: 'libreob-row'});
            for (const item of items.slice(i, i + COLS))
                row.add_child(this._makeCard(item));
            this._rows.add_child(row);
        }

        const adj = vAdjustment(this._scroll);
        if (adj)
            adj.value = 0;

        if (this._focusId) {
            const id = this._focusId;
            this._focusId = null;
            this._later(50, () => this._entries.get(id)?.grab_key_focus());
        }
    }

    _refresh() {
        if (this.menu.isOpen)
            this._rebuild();
    }

    // ----------------------------------------------------------------- cards

    _paint(widget, color) {
        widget.style = `background-color: ${color};`;
    }

    _makeIconButton(iconName, cb) {
        const icon = new St.Icon({icon_name: iconName, icon_size: 14});
        const btn = new St.Button({
            style_class: 'libreob-iconbtn',
            can_focus: true,
            reactive: true,
            track_hover: true,
            child: icon,
        });
        btn.connect('clicked', () => cb(icon));
        return btn;
    }

    _makeCard(item) {
        const slot = new St.BoxLayout({vertical: true, style_class: 'libreob-slot'});
        slot.add_child(new St.Widget({
            style_class: 'libreob-pin',
            x_align: Clutter.ActorAlign.CENTER,
        }));

        const card = new St.BoxLayout({vertical: true, style_class: 'libreob-card'});
        this._paint(card, item.color);
        slot.add_child(card);

        // header: colour dot ........ copy / open / delete
        const head = new St.BoxLayout({style_class: 'libreob-card-head'});
        const dot = new St.Button({
            style_class: 'libreob-dot',
            can_focus: true,
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._paint(dot, item.color);
        dot.connect('clicked', () => {
            const idx = COLORS.indexOf(item.color);
            item.color = COLORS[(idx + 1) % COLORS.length];
            this._paint(card, item.color);
            this._paint(dot, item.color);
            this._store.save();
        });
        head.add_child(dot);
        head.add_child(new St.Widget({x_expand: true}));

        head.add_child(this._makeIconButton('edit-copy-symbolic', icon => {
            if (this._copy(item))
                this._flash(icon, 'edit-copy-symbolic');
        }));
        if (item.type !== 'note')
            head.add_child(this._makeIconButton('document-open-symbolic', () => this._open(item)));
        head.add_child(this._makeIconButton('window-close-symbolic', () => {
            this._store.remove(item.id);
            this._rebuild();
        }));
        card.add_child(head);

        if (item.type === 'note')
            card.add_child(this._noteBody(item));
        else if (item.type === 'image')
            this._imageBody(card, item);
        else
            this._fileBody(card, item);

        return slot;
    }

    _noteBody(item) {
        const scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });

        const entry = new St.Entry({
            style_class: 'libreob-note',
            hint_text: 'Write something…',
            can_focus: true,
            x_expand: true,
        });
        const ct = entry.clutter_text;
        ct.set_single_line_mode(false);
        ct.set_activatable(false);
        ct.set_line_wrap(true);
        ct.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        ct.set_ellipsize(Pango.EllipsizeMode.NONE);
        entry.set_text(item.text ?? '');

        ct.connect('text-changed', () => {
            item.text = ct.get_text();
            this._store.save();
        });
        ct.connect('notify::cursor-position', () => this._followCursor(scroll, ct));

        scroll.set_child(entry);
        scroll.connect('button-press-event', () => {
            entry.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });

        this._entries.set(item.id, entry);
        return scroll;
    }

    _followCursor(scroll, ct) {
        try {
            const adj = vAdjustment(scroll);
            if (!adj)
                return;
            const [ok, , y, h] = ct.position_to_coords(-1);
            if (!ok)
                return;
            if (y < adj.value)
                adj.value = y;
            else if (y + h > adj.value + adj.page_size)
                adj.value = y + h - adj.page_size;
        } catch (_e) {
            // cosmetic only
        }
    }

    _imageBody(card, item) {
        const file = Gio.File.new_for_path(this._store.pathFor(item));
        const btn = new St.Button({
            style_class: 'libreob-media',
            x_expand: true,
            y_expand: true,
            reactive: true,
            can_focus: true,
            track_hover: true,
            child: new St.Icon({gicon: new Gio.FileIcon({file}), icon_size: 128}),
        });
        btn.connect('clicked', () => this._open(item));
        card.add_child(btn);
        card.add_child(this._ellipsized(item.name, 'libreob-caption'));
    }

    _fileBody(card, item) {
        const gicon = Gio.content_type_get_icon(item.mime || 'application/octet-stream');
        const box = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Icon({gicon, icon_size: 64}));
        box.add_child(this._ellipsized(item.name, 'libreob-filename'));
        box.add_child(new St.Label({
            text: GLib.format_size(item.size ?? 0),
            style_class: 'libreob-filemeta',
        }));

        const btn = new St.Button({
            style_class: 'libreob-media',
            x_expand: true,
            y_expand: true,
            reactive: true,
            can_focus: true,
            track_hover: true,
            child: box,
        });
        btn.connect('clicked', () => this._open(item));
        card.add_child(btn);
    }

    _ellipsized(text, styleClass) {
        const label = new St.Label({text, style_class: styleClass});
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.MIDDLE);
        return label;
    }

    _flash(icon, restore) {
        let alive = true;
        icon.connect('destroy', () => (alive = false));
        icon.icon_name = 'object-select-symbolic';
        this._later(900, () => {
            if (alive)
                icon.icon_name = restore;
        });
    }

    // --------------------------------------------------------------- actions

    _addNote(text = '') {
        const item = this._store.addNote(text);
        this._focusId = item.id;
        this._rebuild();
    }

    _open(item) {
        try {
            const uri = Gio.File.new_for_path(this._store.pathFor(item)).get_uri();
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError('libreob', e.message);
        }
        this.menu.close();
    }

    _copy(item) {
        const cb = St.Clipboard.get_default();
        const T = St.ClipboardType.CLIPBOARD;
        try {
            if (item.type === 'note') {
                cb.set_text(T, item.text ?? '');
            } else if (item.type === 'image') {
                const [, data] = GLib.file_get_contents(this._store.pathFor(item));
                cb.set_content(T, item.mime, GLib.Bytes.new(data));
            } else {
                const uri = Gio.File.new_for_path(this._store.pathFor(item)).get_uri();
                cb.set_content(T, 'x-special/gnome-copied-files',
                    GLib.Bytes.new(new TextEncoder().encode(`copy\n${uri}`)));
            }
            return true;
        } catch (e) {
            Main.notifyError('libreob', `Could not copy: ${e.message}`);
            return false;
        }
    }

    _addUris(uris) {
        for (const uri of uris) {
            this._store.addFile(Gio.File.new_for_uri(uri), item => {
                if (item)
                    this._refresh();
            });
        }
    }

    _pickFiles() {
        this.menu.close();
        try {
            const picker = this._ext.dir.get_child('picker.js').get_path();
            this._proc = Gio.Subprocess.new(['gjs', '-m', picker], Gio.SubprocessFlags.STDOUT_PIPE);
            this._proc.communicate_utf8_async(null, this._cancellable, (proc, res) => {
                try {
                    const [, stdout] = proc.communicate_utf8_finish(res);
                    const uris = (stdout ?? '').split('\n').filter(l => l.startsWith('file://'));
                    if (uris.length)
                        this._addUris(uris);
                } catch (_e) {
                    // cancelled or picker closed
                }
            });
        } catch (e) {
            Main.notifyError('libreob', `Could not open the file picker: ${e.message}`);
        }
    }

    _clipboardHasText(mimes) {
        return mimes.some(m => m.startsWith('text/plain') || m === 'UTF8_STRING' || m === 'STRING');
    }

    _paste() {
        const cb = St.Clipboard.get_default();
        const T = St.ClipboardType.CLIPBOARD;
        const mimes = cb.get_mimetypes(T);

        const fileMime = ['x-special/gnome-copied-files', 'text/uri-list'].find(m => mimes.includes(m));
        if (fileMime) {
            cb.get_content(T, fileMime, (_c, bytes) => {
                const uris = decode(bytes).split(/\r?\n/).filter(l => l.startsWith('file://'));
                if (uris.length)
                    this._addUris(uris);
                else
                    this._pasteText();
            });
            return;
        }

        const imageMime = mimes.find(m => IMAGE_MIMES.includes(m));
        if (imageMime) {
            cb.get_content(T, imageMime, (_c, bytes) => {
                const data = bytes?.get_data();
                if (!data)
                    return;
                this._store.addImageData(data, imageMime);
                this._refresh();
            });
            return;
        }

        this._pasteText();
    }

    _pasteText() {
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (text && text.trim())
                this._addNote(text);
        });
    }

    _onKey(_actor, event) {
        const sym = event.get_key_symbol();
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (!ctrl || (sym !== Clutter.KEY_v && sym !== Clutter.KEY_V))
            return Clutter.EVENT_PROPAGATE;

        if (global.stage.key_focus instanceof Clutter.Text) {
            // normal text paste inside a note, unless the clipboard has no text
            const mimes = St.Clipboard.get_default().get_mimetypes(St.ClipboardType.CLIPBOARD);
            if (this._clipboardHasText(mimes))
                return Clutter.EVENT_PROPAGATE;
        }
        this._paste();
        return Clutter.EVENT_STOP;
    }

    // --------------------------------------------------------------- cleanup

    destroy() {
        this._cancellable.cancel();
        this._proc?.force_exit();
        this._proc = null;
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        this._store.destroy();
        super.destroy();
    }
});

export default class LibreobExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
