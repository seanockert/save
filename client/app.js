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

    startPolling() {
      this._pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') this.checkForUpdates();
      }, 15000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.checkForUpdates();
      });
    },

    async checkForUpdates() {
      if (!this.authenticated) return;
      // Skip while paginated, editing, or holding an undoable delete; picked up later.
      if (this.page !== 1 || this.editing || this.pendingDelete) return;

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
        this._lastVersion = version;
        await Promise.all([this.loadBookmarks(true), this.loadTags()]);
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
        this._lastVersion = null;
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
          if (!this.searchTerm() && !this.activeTag) {
            if (!this.bookmarks.some((b) => b.id === res.id)) {
              this.bookmarks = [res, ...this.bookmarks];
            }
          }
          this.loadTags();
          this._lastVersion = null; // re-baseline; our own change isn't a remote update
          this.pollForMetadata(res.id);
        }
      } catch (e) {
        this.saveError = e.message;
      } finally {
        this.saving = false;
      }
    },

    async pollForMetadata(id, attempts = 0) {
      if (attempts >= 3) return;
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const updated = await this.api(`/bookmarks/${id}`);
        if (!updated) return;
        const idx = this.bookmarks.findIndex((b) => b.id === id);
        if (idx === -1) return;
        const current = this.bookmarks[idx];
        if (updated.title !== current.title || updated.image !== current.image) {
          this.bookmarks[idx] = { ...current, ...updated };
          this.bookmarks = [...this.bookmarks];
          return;
        }
        this.pollForMetadata(id, attempts + 1);
      } catch {}
    },

    async loadBookmarks(reset) {
      if (reset) this.page = 1;
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
        this._lastVersion = null; // re-baseline after our own edit
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
      this._undoTimer = setTimeout(() => this.commitDelete(), 6000);
    },

    undoDelete() {
      if (!this.pendingDelete) return;
      clearTimeout(this._undoTimer);
      const { bookmark, index } = this.pendingDelete;
      this.pendingDelete = null;
      this.restoreBookmark(bookmark, index);
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
