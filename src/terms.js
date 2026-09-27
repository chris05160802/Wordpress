import { htmlToText } from './util.js';

const normalize = (name) => htmlToText(name).toLowerCase();

/**
 * Maps category/tag names to IDs on one site. Term IDs differ between sites, so batch
 * operations work with names and resolve them per site. Lookups and creations are
 * memoized as promises so concurrent tasks never create the same term twice.
 */
export class TermResolver {
  constructor(client) {
    this.client = client;
    this.found = new Map();
    this.created = new Map();
  }

  async resolveOne(taxonomy, name, create = false) {
    const key = `${taxonomy}\u0000${normalize(name)}`;
    if (!this.found.has(key)) {
      const lookup = this.#find(taxonomy, name);
      this.found.set(key, lookup);
      lookup.catch(() => this.found.delete(key));
    }
    const id = await this.found.get(key);
    if (id != null || !create) return id;

    if (!this.created.has(key)) {
      const creation = this.#create(taxonomy, name);
      this.created.set(key, creation);
      creation.then(
        (newId) => this.found.set(key, Promise.resolve(newId)),
        () => this.created.delete(key),
      );
    }
    return this.created.get(key);
  }

  /** Resolves names to IDs; unknown names are skipped unless create is true. */
  async resolve(taxonomy, names, { create = false } = {}) {
    const ids = [];
    for (const name of names) {
      const id = await this.resolveOne(taxonomy, name, create);
      if (id != null) ids.push(id);
    }
    return [...new Set(ids)];
  }

  async #find(taxonomy, name) {
    const target = normalize(name);
    const list = await this.client.get(`/wp/v2/${taxonomy}`, { search: name, per_page: 100, _fields: 'id,name' });
    const hit = Array.isArray(list) ? list.find((t) => normalize(t.name) === target) : null;
    return hit ? hit.id : null;
  }

  async #create(taxonomy, name) {
    try {
      return (await this.client.post(`/wp/v2/${taxonomy}`, { name })).id;
    } catch (err) {
      if (err.code === 'term_exists' && err.data?.term_id) return err.data.term_id;
      throw err;
    }
  }
}
