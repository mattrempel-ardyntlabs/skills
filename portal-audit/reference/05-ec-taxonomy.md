# Employee Center Taxonomy and Topic Governance

The unified taxonomy is a hierarchy of topics consolidating requests, articles, quick links and communications across departments. It drives navigation (mega menu, side navigation), topic browsing and detail pages, and search facets.

This phase produces a standalone section of the audit report. Clients read it first.

## Taxonomy form fields

Taxonomy records live in the **`taxonomy`** table.

| Field | Description |
|---|---|
| Name | Unique name identifying the taxonomy |
| **Managers** | Managers or manager group of the taxonomy content |
| Application | Application scope the taxonomy belongs to, for example Employee Center Pro or Employee Center Pro Kiosk |
| Active | Whether the taxonomy content is active |
| Domain | Domain the taxonomy content belongs to |
| Description | Description of the taxonomy content |

Multiple taxonomies can exist. A common pattern is one for desktop EC and a clone for Now Mobile / MESP.

## Topic form fields

Topic records live in the **`topic`** table. Use `topic` for `record_refs` and for `<table>.do` deep links. Do not use the value of the Template field as a table name — see the Template row below.

| Field | Description |
|---|---|
| Name | Topic name. Avoid the `/` character. **Re-index content after topic name edits** |
| Taxonomy | Taxonomy this topic belongs to |
| Template | Reference to the `sp_page` that renders this topic. **This is a page `id`, not a table name.** The EC portal default is the page whose id is `emp_taxonomy_topic` (title "Employee Topic"); kiosk uses `eck_taxonomy_topic`. Topic *records* live in the `topic` table — resolve `template` through `sp_page` when you need the page, and reference `topic` when you need the record |
| Parent topic | Blank if this is a root topic |
| Application | Employee Center by default |
| Active | Makes the topic available for use |
| Apply template to child topics | Applies the parent template to children |
| Order | Display order |
| Description | Brief description |
| Icon | Recommended 56x56px topic, 28x28px sub-topic |
| Banner Image | Recommended 1440x400px home page banner, 1258x300px topic page |
| **Topic manager** | Names of topic managers with access to the topic |
| **Topic contributor** | Names of topic contributors with access to the topic |
| **Enable user criteria check** | Opts the topic into topic-level access control. Default: Disable |
| **Available For** | User criteria for whom the topic is visible. Appears only when the toggle is on |
| **Not Available For** | User criteria for whom the topic is not visible. Appears only when the toggle is on |

Topic name changes require manual reindexing of the topic table for its corresponding indexed sources. Cross-check recently renamed topics against index freshness.

## Topic-level access control

Available from the **Yokohama** family release, so it applies on all three tracked releases.

Role required: `taxonomy_admin`. User criteria required: Taxonomy Manager, Taxonomy Contributor, Topic Manager, Topic Contributor.

### Documented behavior

- Enable user criteria check determines visibility of the current topic **and its child topics** in navigation and the popular topics widget. The criteria set also applies to child topics.
- **Criteria in connected content still govern content visibility on topic pages.** Topic-level criteria control navigation visibility, not content visibility. Both layers are live simultaneously.
- Enabling on a parent topic means subtopics inherit the same criteria automatically.
- Disabling the toggle reverts that topic to the content security model.
- ServiceNow recommends enabling topic criteria when you have many topics, for page load performance, since topic-level checks avoid evaluating content-level access for every item.
- User criteria changes take effect only after re-login.

### The critical misconfiguration

When Enable user criteria check is turned on for the first time, the default values for Available For and Not Available For are **empty, which means the topic is not accessible by any user**. The topic will not appear on the mega menu.

This inverts the generic user criteria truth table in `04-security-model.md`, where empty plus empty means accessible to all. At the topic level, with the toggle on, empty plus empty means visible to nobody.

**Flag every topic in this state as a critical finding.** It is silent, high-impact, and common.

### Inheritance and cloning scenarios

Model these rather than reporting flat values. A topic whose criteria were inherited is a different finding from one where an admin set them deliberately.

| Scenario | Resulting user criteria |
|---|---|
| New topic created with no parent | Remains as defined at creation |
| New topic created with parent | Parent's criteria and visibility applied |
| Topic moved to a new parent | New parent's criteria applied, old parent's removed, manual edits remain intact |
| Topic moved out of hierarchy and made root | Remains as defined at creation |
| Topic cloned to a new parent with empty criteria | Criteria and visibility empty |
| Topic cloned to a new parent with non-empty criteria | New parent's criteria override the cloned topic |
| Parent's criteria change | Revised criteria applied to children |
| Criteria enabled for favorites | A user for whom the topic is not available cannot view the favorited topic, and sees "You don't have access to N of your favorited items" |
| New topic cloned and made root | Cloned topic's criteria and visibility empty |

Note that cloning and moving a topic also clones or moves its associated Guided Self-Service.

## Connected content

The join between taxonomy and actual content.

| Field | Description |
|---|---|
| Content Type | Catalog Item, Knowledge, or Quick Link |
| Catalog item | Appears when Content Type is Catalog Item |
| Knowledge | Appears when Content Type is Knowledge |
| Quick link | Appears when Content Type is Quick Link |
| Topic | The topic the content is associated with |

Connected content criteria govern content visibility on topic pages even when topic-level criteria are enabled.

Other connected-content behaviors: autosync is governed by a system property, outdated connected content has its own management flow (so stale content is an expected, detectable condition), and content can be associated from catalog categories to a topic in bulk.

**Common confusion worth checking explicitly**: the `kb_knowledge` Topic and Category fields are unrelated to Employee Center topics. EC content association uses Connected Content, not the KB Topic field.

## Mobile behavior

A topic rolls up connected content from child topics on the desktop portal but **not on mobile** unless `sn_ex_sp.u_allow.rollup.mesp` is set true. Taxonomy for Now Mobile is managed by cloning the taxonomy.

## Other EC content and configuration objects

All documented in the Employee Center reference, all candidate audit targets: Activity Configuration, Activity Configuration Detail, Approvals experience, Default Employee Profile Header Configuration, Employee Center widgets, Employee Profile, Employee Profile Header Configuration, Employee Profile portal configuration, Enhanced Requests Experience, External Link, Featured Content, Block content, Link content, Footer, Footer Menus, Guided Self-Service, Menu Item, Overview section, Portal notification configuration, Portal notification content, Trigger conditions, Quick Link, Tab widget mapping, Schedule appointment, Location Consent, Website configuration.

### Known gotchas

- External-link quick links reference an External Link record that does **not** auto-capture in update sets.
- Quick links carry their own user criteria many-to-many relationship.
- Some records are created in global scope and must be captured deliberately in the correct update set.
- Employee Center uses multiple application scopes, which drives cross-scope Restricted Caller Access records. Missing or "Requested" rather than "Allowed" RCA records produce read-access errors on `/esc` load. Check these early, because they present as a broken portal rather than a permissions issue.

## Audit checklist for this phase

1. Enumerate taxonomies bound to the portal. Capture Name, Managers, Application scope, Active, Domain.
2. Walk the full topic tree. Capture every field in the Topic form table above.
3. Flag as critical: toggle on, both criteria fields empty.
4. Flag as ungoverned: no Topic manager and no Topic contributor.
5. Model inheritance. Identify inherited-versus-explicit criteria, and topics diverging from parent after manual edit.
6. Count connected content per topic by Content Type. Flag topics with zero connected content.
7. Flag outdated connected content.
8. Cross-check renamed topics against index freshness.
9. Report the governance picture as its own artifact: who manages what, which branches are ungoverned, which access rules are inherited versus explicit.
