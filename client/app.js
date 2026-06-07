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

    _searchTimer: null,

    async init() {
      const ok = await this.checkAuth();
      if (ok) {
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
          limit: '20',
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

    onSearchInput() {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        this.loadBookmarks(true);
      }, 300);
    },

    toggleTagFilter(tag) {
      this.activeTag = this.activeTag === tag ? null : tag;
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
