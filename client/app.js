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

    editing: null,
    editTagsInput: '',

    retagging: false,
    retagProgress: '',

    _searchTimer: null,
    _pollTimer: null,
    _lastVersion: null,

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
      const ok = await this.checkAuth();
      if (ok) {
        await Promise.all([this.loadBookmarks(true), this.loadTags()]);
        this.connectSync();
      }
      this.startPolling();
      this.startInfiniteScroll();
      window.addEventListener('popstate', () => {
        this.readQueryParams();
        if (this.authenticated) this.loadBookmarks(true);
      });
      window.addEventListener('pagehide', () => this.flushPendingDelete());
    },

    isUrl() {
      return /^https?:\/\/.+\..+/.test(this.omni.trim());
    },

    // Effective filter: a URL in the field means "about to save", not "search".
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
      // push for tag toggles (back button works); replace for search keystrokes
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

    // Fallback for when the live feed is down. While the socket is open the
    // server pushes changes and nothing here runs.
    startPolling() {
      this._pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') this.checkForUpdates();
      }, 15000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        this.connectSync();
        this.flushSync(false);
        this.checkForUpdates();
      });
    },

    // Open the live feed. Safe to call at any time; it no-ops unless a new
    // socket is actually needed.
    connectSync() {
      if (!this.authenticated) return;
      if (this._sync) return;

      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;
      try {
        ws = new WebSocket(`${scheme}//${location.host}/api/sync`);
      } catch {
        this.scheduleReconnect();
        return;
      }
      this._sync = ws;

      // Keepalive, answered by the hub without waking it. Per socket, so a
      // late close from an old socket can't stop the live one pinging.
      let pingTimer = null;

      ws.addEventListener('open', () => {
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping');
        }, 45000);
        // Events sent while we were disconnected are not replayed, so a
        // reconnect re-reads the list. A retry count means we dropped.
        if (this._syncRetry > 0) this.flushSync(true);
        this._syncRetry = 0;
      });

      ws.addEventListener('message', (e) => {
        let event;
        try {
          event = JSON.parse(e.data);
        } catch {
          return; // keepalive replies land here
        }
        this.onSyncEvent(event);
      });

      // 'error' is always followed by 'close', so teardown lives there only.
      ws.addEventListener('close', () => {
        clearInterval(pingTimer);
        if (this._sync !== ws) return; // closed on purpose
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

    // Tell the other tabs about a change this tab is holding locally, before it
    // reaches the server. Best effort: with the socket down they pick it up
    // from the poll instead.
    sendSync(event) {
      if (!this._sync || this._sync.readyState !== WebSocket.OPEN) return;
      try {
        this._sync.send(JSON.stringify(event));
      } catch {}
    },

    scheduleReconnect() {
      if (!this.authenticated) return;
      clearTimeout(this._syncTimer);
      const delay = Math.min(30000, 1000 * 2 ** this._syncRetry);
      this._syncRetry++;
      this._syncTimer = setTimeout(() => this.connectSync(), delay);
    },

    // Moving the list now would yank it away from what the user is doing.
    viewBusy() {
      return !!this.editing || !!this.pendingDelete || this.page !== 1;
    },

    onSyncEvent(event) {
      if (!this.authenticated) return;

      if (event.type === 'deleted') {
        // Position-independent, so it applies in any view.
        const gone = this.bookmarks.find((b) => b.id === event.id);
        this.bookmarks = this.bookmarks.filter((b) => b.id !== event.id);
        // Tag pills show counts, so they only move if the row carried tags.
        if (!gone || gone.tags.length) this.loadTags();
        return;
      }

      // A re-tag touches every row, a filtered view can't place a change from
      // the event alone, and a busy view defers: all three want a re-read.
      if (event.type === 'refresh' || this.viewBusy() || this.searchTerm() || this.activeTag) {
        this.flushSync(true);
        return;
      }

      const bm = event.bookmark;
      const idx = this.bookmarks.findIndex((b) => b.id === bm.id);
      if (idx === -1) {
        // A row we never loaded can only be placed if it sorts to the top,
        // which is true of a new bookmark and nothing else.
        if (event.type !== 'created') return;
        this.bookmarks = [bm, ...this.bookmarks];
        return; // a new bookmark has no tags yet
      }

      const before = this.bookmarks[idx];
      this.bookmarks[idx] = { ...before, ...bm };
      this.bookmarks = [...this.bookmarks];
      if (String(before.tags) !== String(bm.tags)) this.loadTags();
    },

    // Re-read the list. Deferred while the view is busy; loadBookmarks clears
    // the flag once any full reload lands.
    flushSync(force) {
      if (force) this._syncDirty = true;
      if (!this._syncDirty) return;
      if (this.viewBusy()) return;
      return Promise.all([this.loadBookmarks(true), this.loadTags()]);
    },

    async checkForUpdates() {
      if (!this.authenticated) return;
      if (this._sync) return; // the live feed is up, or coming up
      if (this.viewBusy()) return; // picked up later

      let res;
      try {
        res = await this.api('/bookmarks/version');
      } catch {
        return;
      }
      if (!res) return;

      const version = `${res.count}:${res.maxUpdatedAt || ''}`;
      if (this._lastVersion === null) {
        this._lastVersion = version; // establish baseline, don't refresh
        return;
      }
      if (version !== this._lastVersion) {
        await this.flushSync(true);
        this._lastVersion = version;
      }
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
        await Promise.all([this.loadBookmarks(true), this.loadTags()]);
        this.connectSync();
      } catch {
        this.loginError = 'connection error';
      } finally {
        this.loggingIn = false;
      }
    },

    async logout() {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
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
        await Promise.all([this.loadBookmarks(true), this.loadTags()]);
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
          this._lastVersion = null; // re-baseline; our own change isn't a remote update
          // Same placement rules as a save on another device. The echoed event
          // is idempotent against this, and carries the metadata when it lands.
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
        this._lastVersion = null; // any full reload makes the poll baseline stale
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

    // Swipe left clears the field (stashing its value); swipe right restores it.
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
      // Don't navigate on the click that trails a swipe.
      if (this._rowScrolled) {
        this._rowScrolled = false;
        return;
      }
      // Don't navigate if the user is selecting text within the card.
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) return;
      window.open(bm.url, '_blank', 'noopener');
    },

    editBookmark(bm) {
      this.editing = {
        id: bm.id,
        title: bm.title || '',
        description: bm.description || '',
      };
      this.editTagsInput = (bm.tags || []).join(', ');
    },

    cancelEdit() {
      this.editing = null;
      this.editTagsInput = '';
      this.flushSync(false);
    },

    async updateBookmark() {
      if (!this.editing) return;
      this.saving = true;
      try {
        const tags = this.editTagsInput
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);

        await this.api(`/bookmarks/${this.editing.id}`, {
          method: 'PUT',
          body: {
            title: this.editing.title,
            description: this.editing.description,
            tags,
          },
        });

        this.editing = null;
        this.editTagsInput = '';
        await Promise.all([this.loadBookmarks(true), this.loadTags()]);
      } catch (e) {
        alert('Failed to update: ' + e.message);
      } finally {
        this.saving = false;
      }
    },

    // Rest the card between the two panels; browsers don't all apply the initial snap.
    centerRow(el) {
      requestAnimationFrame(() => {
        const edit = el.querySelector('.swipe-edit');
        if (edit) el.scrollLeft = edit.offsetWidth;
      });
    },

    // How far the card has been dragged off its centred rest position.
    // Positive means swiped left (delete side), negative means swiped right (edit side).
    swipeOffset(el) {
      return el.scrollLeft + el.clientWidth / 2 - el.scrollWidth / 2;
    },

    rowSwipeStart() {
      this._rowScrolled = false;
    },

    // Arm past the halfway mark so the panel can signal what a release will do.
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

    // Removes the card straight away and holds the DELETE back so it can be undone.
    requestDelete(bm) {
      this.commitDelete();
      const index = this.bookmarks.findIndex((b) => b.id === bm.id);
      if (index === -1) return;
      this.bookmarks = this.bookmarks.filter((b) => b.id !== bm.id);
      this.pendingDelete = { bookmark: bm, index };
      // The DELETE waits out the undo window, so tell the other tabs now
      // rather than leaving the row on screen for six seconds.
      this.sendSync({ type: 'deleted', id: bm.id });
      this._undoTimer = setTimeout(() => this.commitDelete(), 6000);
    },

    undoDelete() {
      if (!this.pendingDelete) return;
      clearTimeout(this._undoTimer);
      const { bookmark, index } = this.pendingDelete;
      this.pendingDelete = null;
      this.restoreBookmark(bookmark, index);
      // The row was never deleted, so have the other tabs re-read it.
      this.sendSync({ type: 'refresh' });
      this.flushSync(false);
    },

    async commitDelete() {
      if (!this.pendingDelete) return;
      clearTimeout(this._undoTimer);
      const { bookmark, index } = this.pendingDelete;
      this.pendingDelete = null;
      try {
        await this.api(`/bookmarks/${bookmark.id}`, { method: 'DELETE' });
        this._lastVersion = null; // re-baseline after our own delete
        await this.loadTags();
        this.flushSync(false);
      } catch (e) {
        this.restoreBookmark(bookmark, index);
        alert('Failed to delete: ' + e.message);
      }
    },

    // Send the held DELETE before the page goes away, so it isn't silently dropped.
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
      const opts = {
        credentials: 'same-origin',
        ...options,
      };
      if (opts.body && typeof opts.body === 'object') {
        opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
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
      if (res.status === 204) return null;
      return res.json();
    },
  };
}

PetiteVue.createApp({ App }).mount();
