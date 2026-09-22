# Service Catalog and Knowledge Bindings

## Service Catalog

| Table | Purpose |
|---|---|
| `sc_catalog` | Catalogs |
| `sc_category` | Categories, self-referencing via parent |
| `sc_cat_item` | Catalog items |
| `sc_cat_item_producer` | Record producers |
| `sc_cat_item_guide` | Order guides |
| `sc_cat_item_wizard` | Wizards |
| `item_option_new` | Variables |
| variable sets | Reusable variable groups |
| catalog client scripts | Client-side item behavior |
| catalog UI policies | Item field behavior |

### Availability controls

An item's visibility on a portal is the product of several independent settings:

- **Active**
- **Roles**
- **Availability**: desktop, mobile
- **Hide on Service Portal** flag
- Category membership and catalog membership
- User criteria at item, category and catalog level

A portal's default catalog is `sp_portal.sc_catalog`, but items can belong to multiple catalogs. Do not assume the default catalog is the only one reachable from the portal.

### Portal rendering

Catalog is rendered through widgets: SC Categories, SC Category Page, SC Catalog Item. `$sp.getCatalogItem()` returns the variable model. The SC Category Page widget calls `$sp.canReadRecord`.

### Common breakage

| Symptom | Cause |
|---|---|
| Item missing from portal but present in platform | Hide on Service Portal flag set |
| Item missing from a category | Missing category mapping, or wrong catalog |
| Category empty for non-admins | ACL on `sc_category` or `sc_catalog` |
| Card view broken for anonymous users | `spUtil.getPreference('catalog-item-list-view')` is empty for guests |
| Item visible to the wrong audience | User criteria at the wrong level, or precedence misunderstood |

## Knowledge Management

| Table | Purpose |
|---|---|
| `kb_knowledge_base` | Knowledge bases |
| `kb_category` | Categories |
| `kb_knowledge` | Articles |
| knowledge blocks | Reusable article fragments, carry their own user criteria |
| article templates | Authoring templates |

Access is governed by user criteria on the knowledge base (can read, cannot read, can contribute) and separately on knowledge blocks.

### Portal specifics

- Articles surface through KB widgets and through search.
- `$sp.getKBRecord()`, `getKBCount()`, `getKBCategoryArticles()`, `getKBTopicArticles()` are the server-side accessors.
- **Article versioning changes the URL format.** With `com.snc.knowledge_serviceportal` and versioning enabled, the version number must be in the URL: `?id=kb_article&sys_id=KB0000005%20V1.0`. A crawler that omits it will fail on every article.
- Draft and expired articles appearing in search by KB number is a known Employee Center issue.

### The KB Topic field trap

The `kb_knowledge` **Topic** and **Category** fields are unrelated to Employee Center topics. EC content association uses Connected Content records. Teams conflate these constantly. Check explicitly and report it if articles were tagged with KB Topics in the belief that this would surface them in EC navigation.

## Audit approach

Follow the sampling strategy in `04-security-model.md`. Enumerate exhaustively at the catalog, category and knowledge base level. Sample beneath.

Useful aggregate findings that do not require per-record evaluation:

- Count of items and articles bound to this portal versus total on the instance.
- Count with user criteria versus without.
- Items with Hide on Service Portal set, as an absolute list, since this list is usually short and always interesting.
- Categories with zero visible items for a given persona. Under the default admin-only run this only reflects admin's own visibility; see the persona model in `03-routing-reachability.md` before treating it as representative of a typical user.
- Knowledge bases bound to the portal but with no articles reachable from it.
- Articles and items reachable through search but not through navigation, and the reverse.
- Retired, draft or expired content still reachable.
