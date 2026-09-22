# Security and Visibility Model

Three independent layers govern what a user sees in a Service Portal. They interact, and an audit that checks only one will produce wrong conclusions.

## Layer 1: Page security by role (`sp_page`)

| Setting | Behavior |
|---|---|
| **Public** checkbox | No login required. Anyone can access |
| **Roles** (comma separated list) | Users without a listed role can still **see links** to the page if those links appear in the portal. Opening the page produces a "page not found" error |
| **Draft** | Only users with the admin role see draft pages. Everyone else gets "page not found" |

If Public is selected **and** roles are listed, the page is still accessible by any user. Public wins.

A number of default portal pages ship marked public. Filter `sp_page` for Public is true to identify them. Setting Public to false prevents public availability.

## Layer 2: Widget security (`sp_widget`)

| Goal | Configuration |
|---|---|
| Restrict to authenticated users | Clear Public, leave Roles blank |
| Restrict to certain roles | Clear Public, populate Roles |
| Restrict what a public widget returns to guests | Select Public, then specify the tables the widget may access for guest users |

Public widgets are accessible by any user **even if the Roles list contains roles**.

When configuring widget security, page security must be configured to match, or users cannot reach the widget through the page it sits on.

## Layer 3: User criteria for Service Portal

This is a distinct, plugin-gated layer separate from catalog and knowledge user criteria. Missing it is a common audit gap.

**Prerequisites**: Service Portal User Criteria Support plugin (`com.glide.service-portal.user-criteria`) active, plus a system property that enables the layer. Role required: admin or `sp_admin`.

> **The gating property name is not confirmed. Do not hardcode one.**
> `glide.service_portal.user_criteria_enabled` was previously documented here as the gate. It does not exist on the reference instance: a `sys_properties` read with `nameSTARTSWITHglide.service_portal.user_criteria` returned **zero rows**, and a broader `nameLIKEuser_criteria` read returned six unrelated properties. Resolve the real name against the target instance's own `sys_properties` before relying on it. Properties that do exist and are easy to confuse with it:
>
> | Property | Observed value | What it actually is |
> |---|---|---|
> | `glide.sc.use_user_criteria` | `true` | Catalog user criteria, not Service Portal |
> | `glide.service_portal.sp_user_criteria.cache_enabled` | `true` | A **cache** toggle for SP user criteria. Not a feature gate |
> | `glide.ux.user_criteria_enabled` | `false` | Next Experience / UX, not Service Portal |
> | `glide.knowman.block_access_with_no_user_criteria` | `true` | Knowledge, not Service Portal |

**Applies to**: pages, widgets, widget instances, announcements, and search sources.

**Applied through**: the Page Editor on the Service Portal Configuration page. Select a page, widget or widget instance node in the page tree, then use the **Who Can View** and **Who Cannot View** related lists.

**Conversion behavior**: when the gating property is set true, any existing roles defined for a page, widget or search source are **automatically converted into user criteria records**. Setting the property false reverts to role-based permissions.

Several user criteria records can apply to a single portal item.

**Critical audit checks**:
- If the gating property is confirmed present **and** confirmed false, user criteria records on pages and widgets are **inert**. Report that as a finding in itself, since teams frequently believe criteria are enforcing when they are not.
- **An empty query result is not evidence that the layer is inert.** A property-name guess that returns no rows tells you the name was wrong, nothing more. Do not report "criteria are inert" on the strength of one unmatched property name — that exact mistake was made against the reference instance, where `glide.sc.use_user_criteria` was in fact `true` and criteria were live. To claim inertness you need a row that exists and reads false, or corroborating behavioral evidence from the crawl. Otherwise report it as **unverified** and say which property names you searched.
- After user criteria additions or changes, users may need to log out and log back in to clear the prior configuration. Do not report an observed-versus-configured discrepancy as a defect without accounting for this.

## Platform user criteria

`user_criteria` records define conditions evaluated against user records, based on role, department, group, location or company. They apply across catalog items, categories and catalogs, knowledge bases, articles and knowledge blocks, Employee Center topics and connected content, and separately to the Service Portal objects above.

User criteria is **user-scoped**, identifying the user. It is not context-scoped.

Not-available-for takes precedence over available-for.

### User criteria output truth table

| Available For | Not Available For | Result |
|---|---|---|
| Not defined | Not defined | Accessible to all users |
| Not defined | Defined | All users except those matching Not Available For |
| Defined | Not defined | Only users matching Available For |
| Defined | Defined | Only users matching Available For |
| Defined | Defined, with some users also matching Available For | Users matching Available For and not matching Not Available For |

**Do not apply this table to Employee Center topics without adjustment.** The topic-level toggle changes the empty-empty case to the opposite result. See `05-ec-taxonomy.md`.

The User Criteria Diagnostics tool assists debugging.

## ACLs

Record-level security still governs portal reads.

- `$sp.canReadRecord()` enforces read ACLs inside widget server scripts. A server script that returns records without calling it can leak data, especially on a public widget.
- `gs.hasRole()` checks role membership but is **not** a substitute for an ACL.
- A missing or overly restrictive ACL makes catalog and KB widgets appear empty for non-admins, which presents as a content problem rather than a security one.

## Sampling strategy for Phase 4

The point is coverage and pattern, not enumeration. Organizations have thousands of articles and catalog items. Do not evaluate each one.

### Enumerate exhaustively (small, high-leverage, most likely wrong)

- Service Portal user criteria on pages, widgets, widget instances, announcements and search sources.
- Employee Center topic-level criteria across the whole topic tree.
- User criteria on knowledge **bases**, catalogs, and catalog **categories**.

### Sample and report distributions (large sets)

- Knowledge articles and catalog items beneath the levels above.
- Report: total counts, count with criteria versus without, distinct criteria records in use, usage count per criteria record, and outliers.

A criteria record used once is a different kind of finding from one used four thousand times. Surface both.

### Cross-cutting checks

- Criteria records referencing inactive or empty groups.
- Criteria records with no usages at all (dead configuration).
- Content with both Available For and Not Available For populated in ways that make it unreachable.
- Items visible to everyone that plausibly should not be.

## Public exposure review (Phase 9)

- Enumerate every page on this portal with Public true.
- Enumerate every widget with Public true, plus its guest-accessible table allow list.
- Assess whether the exposure is intentional. Public defaults ship out of the box, so presence is not automatically a defect.
- Review public widget server scripts for direct queries against sensitive tables and for missing `canReadRecord`.

**This is CONFIG evidence only, permanently, not something an added persona unlocks.** Every persona available under this audit's model is authenticated, whether admin or an impersonated real user (see `03-routing-reachability.md`), so there is never a genuinely logged-out browser session to confirm what an anonymous visitor actually sees. State the exposure list as configuration, not as observed rendering, in every run, regardless of how many personas were tested.

## Related security features

Documented under Managing portal access, all candidate audit targets: single sign-on, logins and URL redirects (system properties plus script includes, notably `SPEntryPage`), multifactor authentication, e-signature for Service Portal, external user self-registration, and PIV/CAC card login.
