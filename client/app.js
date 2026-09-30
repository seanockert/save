function App() {
  return {
    authenticated: false,
    password: '',
    loggingIn: false,
    loginError: '',

    omni: '',
    saving: false,
    saveError: '',

    bookmarks: [],
    loading: false,
    page: 1,
    hasMore: false,
    activeTag: null,
    allTags: [],

    editOpen: false,
    editing: {},
    editTagsInput: '',
    copiedId: null,

    retagging: false,
    retagProgress: '',

    _searchTimer: null,

    _sync: null,
    _syncTimer: null,
    _syncRetry: 0,
    _syncDirty: false,

    _swipeX: null,
    _swipeCleared: {},

    pendingDelete: null,
    _undoTimer: null,
    _rowScrolled: false,

    async init() {
      this.readQueryParams();
      if (await this.checkAuth()) {
        this.connectSync();
        await Promise.all([this.loadBookmarks(true), this.loadTags()]);
      }
      this.startInfiniteScroll();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        this.connectSync();
        this.flushSync(false);
      });
      window.addEventListener('popstate', () => {
        this.readQueryParams();
        if (this.authenticated) this.loadBookmarks(true);
      });
      window.addEventListener('pagehide', () => this.flushPendingDelete());
    },

    isUrl() {
      return /^https?:\/\/.+\..+/.test(this.omni.trim());
    },

    searchTerm() {
      return this.isUrl() ? '' : this.omni.trim();
    },

    readQueryParams() {
      const p = new URLSearchParams(location.search);
      this.omni = p.get('q') || '';
      this.activeTag = p.get('tag') || null;
    },

    writeQueryParams(push) {
      const p = new URLSearchParams();
      if (this.searchTerm()) p.set('q', this.searchTerm());
      if (this.activeTag) p.set('tag', this.activeTag);
      const qs = p.toString();
      const url = qs ? `${location.pathname}?${qs}` : location.pathname;
      if (push) history.pushState(null, '', url);
      else history.replaceState(null, '', url);
    },

    startInfiniteScroll() {
      window.addEventListener(
        'scroll',
        () => {
          if (this.loading || !this.hasMore || !this.authenticated) return;
          if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 600) {
            this.loadMore();
          }
        },
        { passive: true }
      );
    },

    connectSync() {
      if (!this.authenticated || this._sync) return;

      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;
      try {
        ws = new WebSocket(`${scheme}//${location.host}/api/sync`);
      } catch {
        this.scheduleReconnect();
        return;
      }
      this._sync = ws;

      let pingTimer = null;

      ws.addEventListener('open', () => {
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping');
        }, 45000);
        // Missed events are not replayed.
        if (this._syncRetry > 0) this.flushSync(true);
        this._syncRetry = 0;
      });

      ws.addEventListener('message', (e) => {
        let event;
        try {
          event = JSON.parse(e.data);
        } catch {
          return;
        }
        this.onSyncEvent(event);
      });

      // 'error' is always followed by 'close'.
      ws.addEventListener('close', () => {
        clearInterval(pingTimer);
        if (this._sync !== ws) return;
        this._sync = null;
        this.scheduleReconnect();
      });
    },

    disconnectSync() {
      clearTimeout(this._syncTimer);
      const ws = this._sync;
      this._sync = null;
      this._syncRetry = 0;
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
    },

    scheduleReconnect() {
      if (!this.authenticated) return;
      clearTimeout(this._syncTimer);
      const delay = Math.min(30000, 1000 * 2 ** this._syncRetry);
      this._syncRetry++;
      this._syncTimer = setTimeout(() => this.connectSync(), delay);
    },

    viewBusy() {
      return this.editOpen || !!this.pendingDelete || this.page !== 1;
    },

    onSyncEvent(event) {
      if (!this.authenticated) return;

      if (event.type === 'deleted') {
        const gone = this.bookmarks.find((b) => b.id === event.id);
        this.bookmarks = this.bookmarks.filter((b) => b.id !== event.id);
        if (!gone || gone.tags.length) this.loadTags();
        return;
      }

      if (event.type === 'refresh' || this.viewBusy() || this.searchTerm() || this.activeTag) {
        this.flushSync(true);
        return;
      }

      const bm = event.bookmark;
      const idx = this.bookmarks.findIndex((b) => b.id === bm.id);
      if (idx === -1) {
        const top = this.bookmarks[0];
        if (event.type !== 'created' || (top && bm.createdAt < top.createdAt)) return;
        this.bookmarks = [bm, ...this.bookmarks];
        return;
      }

      const before = this.bookmarks[idx];
      this.bookmarks[idx] = { ...before, ...bm };
      this.bookmarks = [...this.bookmarks];
      if (String(before.tags) !== String(bm.tags)) this.loadTags();
    },

    flushSync(force) {
      if (force) this._syncDirty = true;
      if (!this._syncDirty) return;
      if (this.viewBusy()) return;
      return Promise.all([this.loadBookmarks(true), this.loadTags()]);
    },

    async checkAuth() {
      try {
        const res = await fetch('/api/auth/check', { credentials: 'same-origin' });
        this.authenticated = res.ok;
        return res.ok;
      } catch {
        this.authenticated = false;
        return false;
      }
    },

    async login() {
      this.loggingIn = true;
      this.loginError = '';
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ password: this.password }),
        });
        if (!res.ok) {
          this.loginError = 'wrong password';
          return;
        }
        this.authenticated = true;
        this.password = '';
        this.connectSync();
        await Promise.all([this.loadBookmarks(true), this.loadTags()]);
      } catch {
        this.loginError = 'connection error';
      } finally {
        this.loggingIn = false;
      }
    },

    async logout() {
      this.flushPendingDelete();
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      } catch {}
      this.authenticated = false;
      this.disconnectSync();
      this.bookmarks = [];
      this.allTags = [];
    },

    async retagAll() {
      if (this.retagging) return;
      if (!confirm('Re-generate tags for every bookmark? This replaces all existing tags.')) return;
      this.retagging = true;
      this.retagProgress = '0%';
      try {
        let offset = 0;
        let done = false;
        let failed = 0;
        while (!done) {
          const res = await this.api(`/bookmarks/retag?offset=${offset}&limit=20`, { method: 'POST' });
          if (!res) break;
          offset = res.nextOffset;
          done = res.done;
          failed += res.failed || 0;
          this.retagProgress = res.total
            ? `${Math.round((Math.min(offset, res.total) / res.total) * 100)}%`
            : '100%';
        }
        if (this._sync?.readyState !== WebSocket.OPEN) await this.flushSync(true);
        if (failed > 0) {
          alert(`Tag generation failed for ${failed} bookmark${failed === 1 ? '' : 's'} (their existing tags were kept). Check the server logs.`);
        }
      } catch (e) {
        alert('Re-tag failed: ' + e.message);
      } finally {
        this.retagging = false;
        this.retagProgress = '';
      }
    },

    onOmniSubmit() {
      if (this.isUrl()) this.saveBookmark();
    },

    onOmniPaste(e) {
      const text = e.clipboardData?.getData('text') || '';
      if (!text.includes('\n')) return;
      e.preventDefault();
      this.newNote(text);
    },

    isNote(bm) {
      return bm?.type === 'text';
    },

    label(bm) {
      if (!bm) return '';
      if (this.isNote(bm)) return bm.description.slice(0, 40);
      return bm.title || bm.url;
    },

    newNote(text) {
      this.editing = { id: null, note: true, description: text.trim() };
      this.editOpen = true;
      this.editTagsInput = '';
    },

    async createNote() {
      const text = this.editing.description.trim();
      if (!text) return;
      this.saving = true;
      try {
        const res = await this.api('/bookmarks', {
          method: 'POST',
          body: { type: 'text', description: text },
        });
        if (res) {
          this.editOpen = false;
          if (this.omni) {
            this.omni = '';
            this.writeQueryParams(false);
            await this.loadBookmarks(true);
          } else {
            this.onSyncEvent({ type: 'created', bookmark: res });
          }
        }
      } catch (e) {
        alert('Failed to save note: ' + e.message);
      } finally {
        this.saving = false;
      }
    },

    async copyNote(bm) {
      try {
        await navigator.clipboard.writeText(bm.description);
        this.copiedId = bm.id;
        setTimeout(() => {
          if (this.copiedId === bm.id) this.copiedId = null;
        }, 1500);
      } catch {}
    },

    async saveBookmark() {
      if (!this.isUrl()) return;
      this.saving = true;
      this.saveError = '';
      try {
        const res = await this.api('/bookmarks', {
          method: 'POST',
          body: { url: this.omni.trim() },
        });
        if (res) {
          this.omni = '';
          this.onSyncEvent({ type: 'created', bookmark: res });
        }
      } catch (e) {
        this.saveError = e.message;
      } finally {
        this.saving = false;
      }
    },

    async loadBookmarks(reset) {
      if (reset) {
        this.page = 1;
        this._syncDirty = false;
      }
      this.loading = true;
      try {
        const params = new URLSearchParams({
          page: String(this.page),
          limit: '50',
        });
        if (this.searchTerm()) params.set('search', this.searchTerm());
        if (this.activeTag) params.set('tag', this.activeTag);

        const res = await this.api(`/bookmarks?${params}`);
        if (res) {
          this.bookmarks = reset ? res.data : [...this.bookmarks, ...res.data];
          this.hasMore = res.hasMore;
        }
      } catch (e) {
        console.error('Failed to load bookmarks:', e);
      } finally {
        this.loading = false;
      }
    },

    loadMore() {
      this.page++;
      this.loadBookmarks(false);
    },

    swipeStart(e) {
      this._swipeX = e.changedTouches[0].clientX;
    },

    // Swipe left clears the field; swipe right restores it.
    swipeEnd(e, field) {
      if (this._swipeX === null) return;
      const dx = e.changedTouches[0].clientX - this._swipeX;
      this._swipeX = null;
      if (Math.abs(dx) < 60) return;

      if (dx < 0 && this[field]) {
        this._swipeCleared[field] = this[field];
        this[field] = '';
      } else if (dx > 0 && !this[field] && this._swipeCleared[field]) {
        this[field] = this._swipeCleared[field];
        this._swipeCleared[field] = null;
      } else {
        return;
      }

      if (field === 'omni') this.onOmniInput();
    },

    clearOmni() {
      if (!this.omni) return;
      this.omni = '';
      this.onOmniInput();
    },

    onOmniInput() {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        this.writeQueryParams(false);
        this.loadBookmarks(true);
      }, 300);
    },

    toggleTagFilter(tag) {
      this.activeTag = this.activeTag === tag ? null : tag;
      this.writeQueryParams(true);
      this.loadBookmarks(true);
    },

    async loadTags() {
      try {
        const res = await this.api('/tags');
        if (res) this.allTags = res;
      } catch {}
    },

    openBookmark(bm) {
      if (this._rowScrolled) {
        this._rowScrolled = false;
        return;
      }
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) return;
      if (this.isNote(bm)) this.editBookmark(bm);
      else window.open(bm.url, '_blank', 'noopener');
    },

    editBookmark(bm) {
      this.editing = {
        id: bm.id,
        note: this.isNote(bm),
        title: bm.title || '',
        description: bm.description || '',
      };
      this.editOpen = true;
      this.editTagsInput = (bm.tags || []).join(', ');
    },

    cancelEdit() {
      this.editOpen = false;
      this.editTagsInput = '';
      this.flushSync(false);
    },

    // Not .enter.meta: petite-vue fires that on Cmd alone.
    onModalEnter(e) {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      this.saveEdit();
    },

    saveEdit() {
      if (!this.editOpen) return;
      if (this.editing.id) this.updateBookmark();
      else this.createNote();
    },

    async updateBookmark() {
      this.saving = true;
      try {
        const tags = this.editTagsInput
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);

        await this.api(`/bookmarks/${this.editing.id}`, {
          method: 'PUT',
          body: {
            title: this.editing.note ? undefined : this.editing.title,
            description: this.editing.description,
            tags,
          },
        });

        this.editOpen = false;
        this.editTagsInput = '';
        await Promise.all([this.loadBookmarks(true), this.loadTags()]);
      } catch (e) {
        alert('Failed to update: ' + e.message);
      } finally {
        this.saving = false;
      }
    },

    // Not all browsers apply the initial snap.
    centerRow(el) {
      requestAnimationFrame(() => {
        const edit = el.querySelector('.swipe-edit');
        if (edit) el.scrollLeft = edit.offsetWidth;
      });
    },

    // > 0: towards delete. < 0: towards edit.
    swipeOffset(el) {
      return el.scrollLeft + el.clientWidth / 2 - el.scrollWidth / 2;
    },

    rowSwipeStart() {
      this._rowScrolled = false;
    },

    rowSwipeScroll(e) {
      const el = e.currentTarget;
      const dx = this.swipeOffset(el);
      const threshold = el.clientWidth / 2;
      this._rowScrolled = true;
      el.classList.toggle('armed-delete', dx >= threshold);
      el.classList.toggle('armed-edit', dx <= -threshold);
    },

    rowSwipeEnd(e, bm) {
      const el = e.currentTarget;
      const dx = this.swipeOffset(el);
      const threshold = el.clientWidth / 2;
      el.classList.remove('armed-delete', 'armed-edit');
      if (dx >= threshold) this.requestDelete(bm);
      else if (dx <= -threshold) this.editBookmark(bm);
    },

    requestDelete(bm) {
      this.commitDelete();
      const index = this.bookmarks.findIndex((b) => b.id === bm.id);
      if (index === -1) return;
      this.bookmarks = this.bookmarks.filter((b) => b.id !== bm.id);
      this.pendingDelete = { bookmark: bm, index };
      this._undoTimer = setTimeout(() => this.commitDelete(), 6000);
    },

    undoDelete() {
      if (!this.pendingDelete) return;
      clearTimeout(this._undoTimer);
      const { bookmark, index } = this.pendingDelete;
      this.pendingDelete = null;
      this.restoreBookmark(bookmark, index);
      this.flushSync(false);
    },

    async commitDelete() {
      if (!this.pendingDelete) return;
      clearTimeout(this._undoTimer);
      const { bookmark, index } = this.pendingDelete;
      this.pendingDelete = null;
      try {
        await this.api(`/bookmarks/${bookmark.id}`, { method: 'DELETE' });
        this.flushSync(false);
      } catch (e) {
        this.restoreBookmark(bookmark, index);
        alert('Failed to delete: ' + e.message);
      }
    },

    flushPendingDelete() {
      if (!this.pendingDelete) return;
      const { bookmark } = this.pendingDelete;
      this.pendingDelete = null;
      clearTimeout(this._undoTimer);
      fetch(`/api/bookmarks/${bookmark.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        keepalive: true,
      }).catch(() => {});
    },

    restoreBookmark(bookmark, index) {
      const at = Math.min(index, this.bookmarks.length);
      this.bookmarks = [...this.bookmarks.slice(0, at), bookmark, ...this.bookmarks.slice(at)];
    },

    formatDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return d.toLocaleDateString('en-AU', {
        day: 'numeric',
        month: 'short',
        year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
      });
    },

    async api(path, options) {
      const opts = { credentials: 'same-origin', ...options };
      if (opts.body) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(opts.body);
      }
      const res = await fetch(`/api${path}`, opts);
      if (res.status === 401) {
        this.authenticated = false;
        return null;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
  };
}

PetiteVue.createApp({ App }).mount();
