import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Cairo from 'gi://cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {Store, COLORS} from './store.js';

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];
const MODE = Clutter.AnimationMode;

const reduced = () => !St.Settings.get().enable_animations;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hAdj = s => s.hadjustment ?? s.hscroll?.adjustment ?? s.get_hscroll_bar?.()?.adjustment ?? null;
const vAdj = s => s.vadjustment ?? s.vscroll?.adjustment ?? s.get_vscroll_bar?.()?.adjustment ?? null;

function decode(bytes) {
    const data = bytes?.get_data();
    return data ? new TextDecoder().decode(data) : '';
}

/*
 * Motion model taken from Tendedero (PeggedView.swift / Line.swift):
 *  - arrive : drops 46px on a spring and starts swung out 16 degrees
 *  - nudge  : eases to N degrees, then an under-damped spring (k 38, c 2.4)
 *  - gust   : every 7-16s a wave of 1.6-3.4 degree nudges runs along the line
 * plus: scroll inertia, a springy rope, neighbours shaken on landing, gravity
 * when a card is removed, and cards that swing when the pointer brushes them.
 */
const Indicator = GObject.registerClass(
class LibreobIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'libreob', false);

        this._ext = ext;
        this._store = new Store();
        this._cancellable = new Gio.Cancellable();
        this._sources = new Set();
        this._entries = new Map();
        this._slots = [];
        this._bodies = [];
        this._active = new Set();
        this._rope = {x: 0, v: 0, on: false};
        this._sag = 12;
        this._loopId = 0;
        this._gustId = 0;
        this._proc = null;
        this._focusId = null;
        this._sx = 0;
        this._lastX = 0;
        this._lastT = 0;
        this._lastVel = 0;

        this.add_child(new St.Icon({
            icon_name: 'view-pin-symbolic',
            style_class: 'system-status-icon',
        }));

        this.menu.actor.add_style_class_name('libreob-menu');
        this._buildBoard();

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._rebuild({});
                this._later(350, () => this._layout());
                this._scheduleGust();
            } else {
                this._removeSource('_gustId');
                this._stopLoop();
                this._store.flush();
            }
        });
        this.menu.actor.connect('key-press-event', this._onKey.bind(this));
    }

    // ---------------------------------------------------------------- layout

    _buildBoard() {
        this._boardBox = new St.BoxLayout({vertical: true, style_class: 'libreob-board'});

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
        this._boardBox.add_child(header);

        // rope (fixed) underneath, scrolling line of cards on top
        const board = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});

        this._ropeArea = new St.DrawingArea({
            style_class: 'libreob-rope',
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
            reactive: false,
        });
        this._ropeArea.connect('repaint', area => this._drawRope(area));
        board.add_child(this._ropeArea);

        this._scroll = new St.ScrollView({
            style_class: 'libreob-scroll',
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._line = new St.BoxLayout({style_class: 'libreob-line'});
        this._scroll.set_child(this._line);
        board.add_child(this._scroll);

        this._prev = this._makeNav('go-previous-symbolic', Clutter.ActorAlign.START, -1);
        this._next = this._makeNav('go-next-symbolic', Clutter.ActorAlign.END, 1);
        board.add_child(this._prev);
        board.add_child(this._next);

        this._boardBox.add_child(board);
        this.menu.box.add_child(this._boardBox);

        const adj = hAdj(this._scroll);
        adj?.connect('notify::value', () => this._onScrolled(adj));
        this._scroll.connect('scroll-event', this._onWheel.bind(this));
        this._scroll.connect('notify::width', () => this._layout());
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

    _makeNav(iconName, align, dir) {
        const btn = new St.Button({
            style_class: 'libreob-nav',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_align: align,
            y_align: Clutter.ActorAlign.START,
            visible: false,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        btn.connect('clicked', () => this._scrollBy(dir * 420));
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

    _removeSource(prop) {
        if (this[prop]) {
            this._sources.delete(this[prop]);
            GLib.source_remove(this[prop]);
            this[prop] = 0;
        }
    }

    // -------------------------------------------------------- rope + scroll

    _drawRope(area) {
        const [w] = area.get_surface_size();
        const cr = area.get_context();
        const y = 10, qx = w / 2, qy = y + 2 * this._sag;
        const x0 = -w * 0.03, x1 = w * 1.03;
        const c1x = x0 + (2 / 3) * (qx - x0), c1y = y + (2 / 3) * (qy - y);
        const c2x = x1 + (2 / 3) * (qx - x1);

        const stroke = (r, g, b, a, lw, dy) => {
            const p = new Cairo.LinearGradient(0, 0, w, 0); // fades out at both ends
            p.addColorStopRGBA(0, r, g, b, 0);
            p.addColorStopRGBA(0.08, r, g, b, a);
            p.addColorStopRGBA(0.92, r, g, b, a);
            p.addColorStopRGBA(1, r, g, b, 0);
            cr.setSource(p);
            cr.setLineWidth(lw);
            cr.moveTo(x0, y + dy);
            cr.curveTo(c1x, c1y + dy, c2x, c1y + dy, x1, y + dy);
            cr.stroke();
        };
        stroke(0, 0, 0, 0.3, 3, 1.2);
        stroke(0.55, 0.56, 0.6, 1, 1.3, 0);
        stroke(1, 1, 1, 0.45, 0.5, -0.35);
        cr.$dispose();
    }

    /* Cards sit at the rope's height for their x position and fade near the edges. */
    _layout() {
        const w = this._scroll.width;
        if (!w || !this._scroll.mapped)
            return;
        const [sx0] = this._scroll.get_transformed_position();
        this._sag = Math.min(30, w * 0.018) + this._rope.x;
        this._ropeArea.queue_repaint();

        for (const s of this._slots) {
            const [x] = s.get_transformed_position();
            const cx = x - sx0 + s.width / 2;
            const f = clamp(cx / w, 0, 1);
            s._hang.translation_y = 0.5 + 4 * this._sag * f * (1 - f);
            s._hang.opacity = Math.round(clamp(Math.min(cx, w - cx) / 90, 0, 1) * 255);
        }

        const adj = hAdj(this._scroll);
        if (adj) {
            this._prev.visible = adj.value > 4;
            this._next.visible = adj.value + adj.page_size < adj.upper - 4;
        }
    }

    _onScrolled(adj) {
        this._sx = adj.value;
        if (!reduced()) {
            // the pins accelerate, the cards lag behind and swing
            const now = GLib.get_monotonic_time() / 1000;
            const dt = Math.max(8, now - this._lastT) / 1000;
            if (this._lastT && now - this._lastT < 150) {
                const vel = (adj.value - this._lastX) / dt;
                const acc = vel - this._lastVel;
                this._lastVel = vel;
                const dv = clamp(-acc * 0.012, -40, 40);
                if (Math.abs(dv) > 0.3)
                    this._bodies.forEach(b => this._impulse(b, dv * b.m));
            } else {
                this._lastVel = 0;
            }
            this._lastX = adj.value;
            this._lastT = now;
        }
        this._layout();
    }

    _onWheel(_actor, event) {
        const adj = hAdj(this._scroll);
        if (!adj)
            return Clutter.EVENT_PROPAGATE;
        const dir = event.get_scroll_direction();
        let d = 0;
        if (dir === Clutter.ScrollDirection.UP)
            d = -110;
        else if (dir === Clutter.ScrollDirection.DOWN)
            d = 110;
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            if (Math.abs(dy) > Math.abs(dx))
                d = dy * 60;
        }
        if (!d)
            return Clutter.EVENT_PROPAGATE;
        adj.value = clamp(adj.value + d, 0, Math.max(0, adj.upper - adj.page_size));
        return Clutter.EVENT_STOP;
    }

    _scrollBy(px) {
        const adj = hAdj(this._scroll);
        if (!adj)
            return;
        const target = clamp(adj.value + px, 0, Math.max(0, adj.upper - adj.page_size));
        if (adj.ease && !reduced())
            adj.ease(target, {duration: 350, mode: MODE.EASE_OUT_QUAD});
        else
            adj.value = target;
    }

    // ----------------------------------------------------------- rebuilding

    _rebuild(opts = {}) {
        const before = new Map();
        if (opts.flip && !reduced()) {
            for (const s of this._slots)
                before.set(s._id, s.get_transformed_position());
        }

        this._entries.clear();
        this._bodies = [];
        this._slots = [];
        this._active.clear();
        this._line.destroy_all_children();

        const items = this._store.items;
        this._line.add_child(new St.Widget({x_expand: true}));      // spacers centre a short line
        if (items.length === 0) {
            this._line.add_child(new St.Label({
                style_class: 'libreob-empty',
                text: 'Nothing pinned yet.\nAdd a note, pick an image or file,\nor press Ctrl+V to paste one.',
            }));
        } else {
            for (const item of items)
                this._line.add_child(this._makeSlot(item));
        }
        this._line.add_child(new St.Widget({x_expand: true}));

        this._line.opacity = 0;  // hidden until the cards have been allocated
        this._later(30, () => this._settle(before, opts));
    }

    _settle(before, opts) {
        const adj = hAdj(this._scroll);
        if (adj)
            adj.value = opts.fresh ? 0 : this._sx;
        this._sx = adj?.value ?? 0;
        this._lastT = 0;
        this._lastVel = 0;
        this._lastX = this._sx;
        this._layout();

        // the other cards glide to their new places on a spring
        if (before.size) {
            for (const s of this._slots) {
                const old = before.get(s._id);
                if (!old)
                    continue;
                const [x, y] = s.get_transformed_position();
                const dx = old[0] - x, dy = old[1] - y;
                if (Math.abs(dx) + Math.abs(dy) < 1)
                    continue;
                s.translation_x = dx;
                s.translation_y = dy;
                s.ease({translation_x: 0, translation_y: 0, duration: 560, mode: MODE.EASE_OUT_BACK});
            }
        }
        this._line.opacity = 255;

        if (opts.fresh)
            this._bodies.filter(b => opts.fresh.has(b.id)).forEach(b => this._arrive(b));
        if (opts.focusId)
            this._entries.get(opts.focusId)?.grab_key_focus();
    }

    _refresh(opts) {
        if (this.menu.isOpen)
            this._rebuild(opts);
    }

    // ----------------------------------------------------------------- cards

    _makeIconButton(iconName, cb) {
        const btn = new St.Button({
            style_class: 'libreob-iconbtn',
            can_focus: true,
            reactive: true,
            track_hover: true,
            opacity: 0,
            child: new St.Icon({icon_name: iconName, icon_size: 14}),
        });
        btn.set_pivot_point(0.5, 0.5);
        btn.scale_x = btn.scale_y = 0.6;
        btn.connect('clicked', () => cb());
        return btn;
    }

    _makeSlot(item) {
        const slot = new St.BoxLayout({vertical: true, style_class: 'libreob-slot'});
        slot._id = item.id;
        const hang = new St.BoxLayout({vertical: true, x_expand: true});
        slot._hang = hang;
        slot.add_child(hang);

        const sw = new St.BoxLayout({vertical: true, x_expand: true});
        sw.set_pivot_point(0.5, 0);   // everything swings from the top of the clip
        hang.add_child(sw);

        const pin = new St.Widget({style_class: 'libreob-pin', x_align: Clutter.ActorAlign.CENTER});
        sw.add_child(pin);

        const card = new St.Widget({
            style_class: 'libreob-card',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        card.set_pivot_point(0.5, 0);
        card.translation_y = -12;     // the clip overlaps the card
        card.style = `background-color: ${item.color};`;
        sw.add_child(card);
        sw.set_child_above_sibling(pin, null);

        const content = new St.BoxLayout({vertical: true, style_class: 'libreob-content', x_expand: true, y_expand: true});
        card.add_child(content);

        const b = {
            id: item.id, el: sw, slot, tilt: item.tilt ?? 0,
            a: 0, v: 0, x: 0, y: 0, vy: 0, k: 46, c: 2.6,
            tw: null, fall: null, m: 0.85 + Math.random() * 0.3,
        };
        this._bodies.push(b);
        this._slots.push(slot);
        this._apply(b);

        // header: colour dot ...... copy / open / remove (revealed on hover)
        const state = {hover: false, pressed: false, focus: false};
        const acts = [];
        const update = () => {
            const s = state.pressed ? 0.95 : state.hover ? 1.035 : 1;
            const d = reduced() ? 0 : 1;
            card.ease({
                scale_x: s, scale_y: s,
                duration: (state.pressed ? 450 : 220) * d,
                mode: state.pressed ? MODE.EASE_IN_OUT_QUAD : MODE.EASE_OUT_BACK,
            });
            const show = state.hover || state.focus;
            for (const a of acts) {
                a.ease({
                    opacity: show ? 255 : 0,
                    scale_x: show ? 1 : 0.6, scale_y: show ? 1 : 0.6,
                    duration: 180 * d, mode: MODE.EASE_OUT_QUAD,
                });
            }
        };
        card.connect('notify::hover', () => {
            state.hover = card.hover;
            update();
        });
        const track = btn => {
            acts.push(btn);
            btn.connect('key-focus-in', () => {
                state.focus = true;
                update();
            });
            btn.connect('key-focus-out', () => {
                state.focus = false;
                update();
            });
            return btn;
        };

        const head = new St.BoxLayout({style_class: 'libreob-card-head'});
        const dot = new St.Button({style_class: 'libreob-dot', can_focus: true, reactive: true, y_align: Clutter.ActorAlign.CENTER});
        dot.style = `background-color: ${item.color};`;
        dot.connect('clicked', () => {
            item.color = COLORS[(COLORS.indexOf(item.color) + 1) % COLORS.length];
            card.style = `background-color: ${item.color};`;
            dot.style = `background-color: ${item.color};`;
            this._store.save();
        });
        head.add_child(dot);
        head.add_child(new St.Widget({x_expand: true}));
        head.add_child(track(this._makeIconButton('edit-copy-symbolic', () => {
            if (this._copy(item)) {
                this._showCopied(card);
                this._nudge(b, 3);
            }
        })));
        if (item.type !== 'note')
            head.add_child(track(this._makeIconButton('document-open-symbolic', () => this._open(item))));
        head.add_child(track(this._makeIconButton('window-close-symbolic', () => this._remove(item, b))));
        content.add_child(head);

        if (item.type === 'note') {
            content.add_child(this._noteBody(item));
        } else {
            const media = item.type === 'image' ? this._imageBody(content, item) : this._fileBody(content, item);
            media.connect('notify::pressed', () => {
                state.pressed = media.pressed;
                update();
            });
        }

        // brush past a hanging card and it swings
        let lastX = null;
        card.connect('motion-event', (_a, event) => {
            const [x, y] = event.get_coords();
            if (lastX !== null && !reduced() && !sw.contains(global.stage.key_focus)) {
                const [, cy] = card.get_transformed_position();
                const low = clamp((y - cy) / Math.max(1, card.height), 0, 1);
                this._impulse(b, clamp((x - lastX) * 0.9 * low, -14, 14));
            }
            lastX = x;
            return Clutter.EVENT_PROPAGATE;
        });
        card.connect('leave-event', () => {
            lastX = null;
            return Clutter.EVENT_PROPAGATE;
        });

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
            const adj = vAdj(scroll);
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

    _imageBody(content, item) {
        const file = Gio.File.new_for_path(this._store.pathFor(item));
        const btn = new St.Button({
            style_class: 'libreob-media',
            x_expand: true,
            y_expand: true,
            reactive: true,
            can_focus: true,
            track_hover: true,
            child: new St.Icon({gicon: new Gio.FileIcon({file}), icon_size: 116}),
        });
        btn.connect('clicked', () => this._open(item));
        content.add_child(btn);
        content.add_child(this._ellipsized(item.name, 'libreob-caption'));
        return btn;
    }

    _fileBody(content, item) {
        const gicon = Gio.content_type_get_icon(item.mime || 'application/octet-stream');
        const box = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Icon({gicon, icon_size: 64}));
        box.add_child(this._ellipsized(item.name, 'libreob-filename'));
        box.add_child(new St.Label({text: GLib.format_size(item.size ?? 0), style_class: 'libreob-filemeta'}));

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
        content.add_child(btn);
        return btn;
    }

    _ellipsized(text, styleClass) {
        const label = new St.Label({text, style_class: styleClass});
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.MIDDLE);
        return label;
    }

    _showCopied(card) {
        const pill = new St.Label({
            text: 'Copied',
            style_class: 'libreob-copied',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            opacity: 0,
        });
        pill.translation_y = 18;
        card.add_child(pill);
        pill.ease({opacity: 255, duration: reduced() ? 0 : 200, mode: MODE.EASE_OUT_QUAD});
        this._later(1500, () => {
            if (!pill.get_parent())
                return;
            pill.ease({opacity: 0, duration: reduced() ? 0 : 200, onComplete: () => pill.destroy()});
        });
    }

    // --------------------------------------------------------------- physics

    _apply(b) {
        const el = b.el;
        el.rotation_angle_z = b.tilt + b.a;
        el.translation_x = b.x;
        el.translation_y = b.y;
        const o = b.fall ? Math.max(0, 1 - b.fall.t / 0.45) : clamp(1 + b.y / 46, 0, 1);
        el.opacity = Math.round(o * 255);
    }

    _wake(b) {
        this._active.add(b);
        this._startLoop();
    }

    _startLoop() {
        if (this._loopId)
            return;
        this._last = GLib.get_monotonic_time();
        this._loopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => this._tick());
        this._sources.add(this._loopId);
    }

    _stopLoop() {
        this._removeSource('_loopId');
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min(0.032, (now - this._last) / 1e6 || 0.016);
        this._last = now;

        for (const b of [...this._active]) {
            if (!b.el.get_stage()) {
                this._active.delete(b);
                continue;
            }
            if (b.fall) {                       // removed: gravity, spin, fade
                const f = b.fall;
                f.t += dt;
                b.vy += 2600 * dt;
                b.y += b.vy * dt;
                b.x += f.vx * dt;
                b.a += f.vr * dt;
                this._apply(b);
                if (f.t >= 0.45) {
                    this._active.delete(b);
                    f.done();
                }
                continue;
            }
            if (b.tw) {
                b.tw.t += dt;
                const p = Math.min(1, b.tw.t / b.tw.d);
                const e = 1 - (1 - p) ** 3;
                b.a = b.tw.from + (b.tw.to - b.tw.from) * e;
                b.v = 0;
                if (p >= 1) {
                    b.tw = null;
                    b.k = 38;
                    b.c = 2.4;
                }
            } else {
                const n = 3, h = dt / n;
                for (let i = 0; i < n; i++) {
                    b.v += (-b.k * b.a - b.c * b.v) * h;
                    b.a += b.v * h;
                    b.vy += (-223.8 * b.y - 21.5 * b.vy) * h;
                    b.y += b.vy * h;
                }
                b.a = clamp(b.a, -35, 35);
                if (Math.abs(b.a) < 0.01 && Math.abs(b.v) < 0.02 && Math.abs(b.y) < 0.05 && Math.abs(b.vy) < 0.1) {
                    b.a = b.v = b.y = b.vy = 0;
                    this._active.delete(b);
                }
            }
            this._apply(b);
        }

        if (this._rope.on) {                    // the rope is a spring too
            const r = this._rope, n = 3, h = dt / n;
            for (let i = 0; i < n; i++) {
                r.v += (-160 * r.x - 6 * r.v) * h;
                r.x += r.v * h;
            }
            if (Math.abs(r.x) < 0.02 && Math.abs(r.v) < 0.1) {
                r.x = r.v = 0;
                r.on = false;
            }
            this._layout();
        }

        if (this._active.size || this._rope.on)
            return GLib.SOURCE_CONTINUE;
        this._sources.delete(this._loopId);
        this._loopId = 0;
        return GLib.SOURCE_REMOVE;
    }

    _ropeKick(v) {
        if (reduced())
            return;
        this._rope.v += v;
        this._rope.on = true;
        this._startLoop();
    }

    _impulse(b, dv) {
        if (reduced() || b.tw || b.fall)
            return;
        b.v += dv;
        this._wake(b);
    }

    _nudge(b, deg) {
        if (reduced() || b.fall)
            return;
        b.tw = {from: b.a, to: deg, t: 0, d: 0.3};
        b.v = 0;
        this._wake(b);
    }

    _arrive(b) {
        if (reduced())
            return;
        b.a = 16;
        b.v = 0;
        b.y = -46;
        b.vy = 0;
        b.k = 46;
        b.c = 2.6;
        b.tw = null;
        this._apply(b);
        this._wake(b);
        this._later(240, () => this._land(b));
    }

    _land(b) {                                  // landing jolts the rope and the neighbours
        if (!b.el.get_stage())
            return;
        this._ropeKick(70);
        const i = this._bodies.indexOf(b);
        for (const j of [i - 1, i + 1]) {
            const n = this._bodies[j];
            if (n)
                this._impulse(n, (j < i ? -1 : 1) * (8 + Math.random() * 6));
        }
    }

    _scheduleGust() {
        this._removeSource('_gustId');
        if (reduced())
            return;
        this._gustId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 7000 + Math.random() * 9000, () => {
            this._sources.delete(this._gustId);
            this._gustId = 0;
            if (this.menu.isOpen) {
                const [sx0] = this._scroll.get_transformed_position();
                const w = Math.max(1, this._scroll.width);
                for (const b of this._bodies) {
                    if (b.el.contains(global.stage.key_focus))
                        continue;
                    const [x] = b.slot.get_transformed_position();
                    // the gust travels along the line from left to right
                    const delay = Math.max(0, x - sx0) / w * 520 + Math.random() * 50;
                    this._later(delay, () => this._nudge(b, 1.6 + Math.random() * 1.8));
                }
                this._scheduleGust();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(this._gustId);
    }

    // --------------------------------------------------------------- actions

    _remove(item, b) {
        const done = () => {
            this._store.remove(item.id);
            this._rebuild({flip: true});
        };
        if (reduced() || b.fall) {
            done();
            return;
        }
        b.tw = null;
        b.vy = -120;                            // a small hop, then gravity
        b.fall = {
            t: 0,
            vx: (Math.random() - 0.5) * 140,
            vr: (Math.random() < 0.5 ? -1 : 1) * (60 + Math.random() * 90),
            done,
        };
        this._ropeKick(-45);
        this._wake(b);
    }

    _addNote(text = '') {
        const item = this._store.addNote(text);
        this._rebuild({focusId: item.id, fresh: new Set([item.id]), flip: true});
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
                    this._refresh({fresh: new Set([item.id]), flip: true});
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
                const item = this._store.addImageData(data, imageMime);
                this._refresh({fresh: new Set([item.id]), flip: true});
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
        this._loopId = 0;
        this._gustId = 0;
        this._store.destroy();
        super.destroy();
    }
});

export default class LibreobExtension extends Extension {
    enable() {
        this._installFonts();
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }

    /*
     * GNOME Shell's CSS cannot load fonts from a file, so the two bundled fonts
     * are copied once to ~/.local/share/fonts/libreob. They are picked up after
     * the next login; until then the stylesheet falls back to Cantarell.
     */
    _installFonts() {
        try {
            const dest = GLib.build_filenamev([GLib.get_user_data_dir(), 'fonts', 'libreob']);
            if (GLib.file_test(dest, GLib.FileTest.IS_DIR))
                return;
            GLib.mkdir_with_parents(dest, 0o755);
            for (const name of ['Thickhead.ttf', 'Northampton.ttf']) {
                this.dir.get_child('fonts').get_child(name).copy(
                    Gio.File.new_for_path(GLib.build_filenamev([dest, name])),
                    Gio.FileCopyFlags.OVERWRITE, null, null);
            }
            Gio.Subprocess.new(['fc-cache', '-f', dest], Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.warn(`libreob: could not install fonts: ${e.message}`);
        }
    }
}
