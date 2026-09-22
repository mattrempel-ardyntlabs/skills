# Page and Widget Model

## Composition hierarchy

```
sp_page
  └── sp_container      (references parent sp_page)
        └── sp_row      (references container)
              └── sp_column   (references row, Bootstrap sizing col-md-*)
                    └── sp_instance   (widget instance)
                          └── sp_widget
```

Nested containers are supported. Every level supports CSS classes for Bootstrap and flexbox behavior.

**Critical architectural fact**: `sp_page` has no portal reference. Pages are global to the instance. A page is not owned by a portal. This is why reachability, not assignment, defines a portal's page set, and it is the single most important reason the browser crawl exists. See `03-routing-reachability.md`.

## Failure signatures

- **Orphaned containers**: a broken `sp_container.sp_page` reference renders nothing, silently, with no error. Common after partial update set captures, because Service Portal Designer often records only directly-edited records.
- Heavy JSON in instance options.
- Deeply nested containers degrading layout and performance.

## `sp_instance`

The join between a column position and an `sp_widget`. Holds option overrides: `bootstrap_alt` sizing, title, and JSON Additional options.

### Extended instance tables

`sp_instance` is extended per widget type. The base list view will not surface type-specific fields, so the audit must read the child tables:

- `sp_instance_link`
- `sp_instance_menu`
- `sp_instance_carousel` (slides live in a related list on the instance, not in options JSON)
- `sp_instance_table`
- `sp_instance_vlist` (Simple List)
- others exist per widget

## `sp_widget` anatomy

| Component | Purpose |
|---|---|
| HTML template | Angular template, `{{}}` bindings, `${...}` i18n message syntax |
| CSS / SCSS | Compiled with theme SCSS variables, injected per widget and per instance |
| Client script | AngularJS controller, conventionally `api.controller = function($scope){ var c = this; ... }` |
| Server script | Runs first, populates the `data` object |
| Option schema | Defines instance options surfaced in the editor |
| Demo data | Sample data for the editor |
| Link function | Directive link function |

### Option schema has two forms

You can edit the option schema directly on the widget, **or** create a table to store widget instance options instead. Table-backed option schemas allow custom fields of any ServiceNow field type, filters on fields, and querying of instance options.

Audit implication: a portal using table-backed option schemas requires reading those tables, not just the JSON blob on `sp_instance`. Detect this by looking for an option schema table reference on the widget.

## Server and client data contract

- `data` (server side) is serialized to `c.data` (client side).
- `input` is the client payload sent on `c.server.get(input)` or `c.server.update()`.
- `options` holds instance options.
- `$sp` is a `GlideSPScriptable` instance, the server-side convenience API.
- `spUtil` is the client-side utility: `spUtil.update($scope)`, `spUtil.recordWatch()`, `spUtil.getURL()`.
- `c.server.get()` re-runs the server script, clearing `data` and passing `input`.
- `c.server.update()` sends `c.data` back to the server script.

## Widget dependencies

| Table | Purpose |
|---|---|
| `sp_dependency` | Dependency grouping, linked via `m2m_sp_dependency_js_include` and CSS relations |
| `sp_ng_template` | Angular ng-templates |
| `sp_js_include` | JS includes, **ordered**, ordering affects load |
| `sp_css` | CSS includes and stylesheets |
| `sp_angular_provider` | Angular providers and services shared across widgets |

## `$sp` / GlideSPScriptable API surface

Documented and commonly used:

`canReadRecord(gr)` or `canReadRecord(table, sys_id)` (validity plus read access; for `kb_knowledge`, `sc_cat_item` and `sc_category` it also checks view access), `getCatalogItem(sys_id)`, `getDisplayValue(field)`, `getValue(field)` (read from the widget's `sp_instance*` then fall back to `sp_portal`), `getField`, `getFields`, `getFieldsObject`, `getForm(table, sys_id, query, view)`, `getListColumns(table, view)`, `getMenuHREF(gr)`, `getMenuItems(sys_id)`, `getParameter(key)`, `getPortalRecord()`, `getRecord()` (current `sp_instance*` GlideRecord, null if embedded), `getRecordValues`, `getRecordDisplayValues`, `getRecordElements`, `getStream(table, sys_id)`, `getUserInitials`, `getValues`, `getWidget(id, options)`, `getKBRecord`, `getKBCount`, `getKBCategoryArticles`, `getKBTopicArticles`, `getSCRecord()`, `logStat`, `logSearch`, `log`.

Undocumented but present: `saveRecord`, `getInstanceRecord`, `getVariablesArray`, `buildThemeVariableModel`.

### Two methods that change how you audit

**`$sp.getWidget(id, options)`** embeds one widget inside another at runtime. The embedded widget has no `sp_instance` record on the host page. A widget inventory built only from `sp_instance` records will under-count. Cross-reference by grepping widget server and client scripts for `getWidget(` and by observing the rendered DOM.

**`$sp.getParameter(key)`** is where required page parameters are declared in practice. To discover what parameters a page needs, grep the server scripts of the widgets on that page for `getParameter`. There is no declarative list of required parameters anywhere else.

**`$sp.canReadRecord()`** is the security control inside server scripts. A server script returning records without calling it is a potential data exposure, especially on a public widget. See `04-security-model.md`.
