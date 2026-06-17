function App() {
  return {
    authenticated: false,
    password: '',
    loggingIn: false,
    loginError: '',

    newUrl: '',
    saving: false,
    saveError: '',

    bookmarks: [],
    loading: false,
    page: 1,
    hasMore: false,
    searchQuery: '',
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
    },

    readQueryParams() {
      const p = new URLSearchParams(location.search);
      this.searchQuery = p.get('q') || '';
      this.activeTag = p.get('tag') || null;
    },

    writeQueryParams(push) {
      const p = new URLSearchParams();
      if (this.searchQuery) p.set('q', this.searchQuery);
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
      // Poll the version endpoint while visible, and immediately on refocus.
      this._pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') this.checkForUpdates();
      }, 15000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.checkForUpdates();
      });
    },

    async checkForUpdates() {
      if (!this.authenticated) return;
      // Skip while paginated or editing; picked up once back on page 1.
      if (this.page !== 1 || this.editing) return;

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

    async checkClipboard() {
      if (this.newUrl) return;
      try {
        const text = await navigator.clipboard.readText();
        const trimmed = text.trim();
        if (/^https?:\/\/.+\..+/.test(trimmed)) {
          this.newUrl = trimmed;
        }
      } catch {
        // clipboard permission denied — fine
      }
    },

    async saveBookmark() {
      if (!this.newUrl.trim()) return;
      this.saving = true;
      this.saveError = '';
      try {
        const res = await this.api('/bookmarks', {
          method: 'POST',
          body: { url: this.newUrl.trim() },
        });
        if (res) {
          this.newUrl = '';
          if (!this.searchQuery && !this.activeTag) {
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
      } catch {
        // metadata poll failed — not critical
      }
    },

    async loadBookmarks(reset) {
      if (reset) this.page = 1;
      this.loading = true;
      try {
        const params = new URLSearchParams({
          page: String(this.page),
          limit: '50',
        });
        if (this.searchQuery) params.set('search', this.searchQuery);
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

      if (field === 'searchQuery') this.onSearchInput();
    },

    onSearchInput() {
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
      } catch {
        // ignore
      }
    },

    openBookmark(bm) {
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

    async deleteBookmark(id) {
      if (!confirm('Delete this bookmark?')) return;
      try {
        await this.api(`/bookmarks/${id}`, { method: 'DELETE' });
        this.bookmarks = this.bookmarks.filter((b) => b.id !== id);
        this._lastVersion = null; // re-baseline after our own delete
        await this.loadTags();
      } catch (e) {
        alert('Failed to delete: ' + e.message);
      }
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
