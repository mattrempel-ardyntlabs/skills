# Employee Center versus Employee Center Pro

## What Employee Center is technically

Employee Center is a Service Portal (AngularJS) experience delivered by scoped Store applications. It is **not** a UI Builder app.

ServiceNow's Portal Experience FAQs state that Employee Center is based on AngularJS because it is the same tech stack as Service Portal, that UI Builder cannot be used to design Service Portal or Employee Center, and that since San Diego it is not suggested to create enterprise portals using UI Builder or App Engine Studio Portal Experience templates.

## Application chain

| App | Scope | Role |
|---|---|---|
| Employee Center | `sn_ex_sp` | The portal app |
| Employee Center Core | `sn_hr_sp` | Foundational self-service capability, installs automatically with EC. Hosts `sn_hr_sp.esc_admin` |
| Employee experience taxonomy | `sn_ect` | Real, installable scope (seen active, v28.2.5) that owns none of its own tables. Taxonomy data lives on unscoped global tables regardless of whether this app is installed. |
| Employee Experience Foundation | `sn_ex_emp_fd` | Foundation |
| Employee Center Pro | `sn_ex_sp_pro` | Communications and engagement |
| Guided Self-Service in Employee Center | `sn_ex_sp_gd_help` | Interactive troubleshooting flows, bound to topics via `sn_ex_sp_gd_help_m2m_process_topic` |
| Notifications for EC | `sn_ex_sp_notifs` | Seen active alongside the rest of the chain; easy to miss with a fixed enumerated scope list |

**Corrected twice, 2026-09-11 (see `14-open-questions.md`, item 1):** an earlier note here said "there is no `sn_ect` scope on a real instance" — wrong. `sn_ect` is real and was found installed and active on a second instance. What's actually true, and the only thing that matters for table lookups: taxonomy content lives on unscoped global tables (`taxonomy`, `topic`, `taxonomy_content_configuration`, `m2m_connected_content`, `m2m_sp_portal_taxonomy`) whether or not `sn_ect` happens to be installed, because `sn_ect` itself defines none of its own tables. Don't search for a `sn_ect_`-prefixed table; do include `sn_ect` in any app-chain inventory query.

EC Pro Store dependencies also include Content Experiences (`sn_ca`), Content Publishing (`sn_cd`) and Enterprise Service Management Integrations Framework (`sn_hr_integr_fw`). Installing EC Pro also activates the base Employee Center plugin.

Related apps that ship features often assumed to be Pro: Journey Accelerator (`sn_ja`, with Journey Designer), Lifecycle Events (`com.sn_hr_lifecycle_ent`), HR Core (`com.sn_hr_core`), Listening Posts (`sn_lp`), Learning Posts (`sn_lnp`), Manager Hub (`sn_mh`). Journey admin role is `sn_jny.admin`.

Portal access: `/esc`. Mobile equivalent: Mobile Employee Service Portal (`/mesp`), which cannot be deactivated or used as a redirect target.

## Detecting Pro

Check whether `sn_ex_sp_pro` is installed and active, and record versions of every app in the chain. Installed-and-active is the reliable signal. Licensing entitlement is negotiated with the ServiceNow account team and is not always visible as a flag on the instance.

A separate finding worth surfacing: Pro-only tables holding records while the Pro app is not active, which indicates either a lapsed entitlement or a partial uninstall.

## EC Pro feature matrix

Use this as the used-versus-unused checklist. Sourced from the Australia "Exploring Employee Center Pro" benefit-to-feature table.

| Feature | Primary users | What it does |
|---|---|---|
| App Launcher | Employee | Access SSO and non-SSO web applications from the portal home page |
| Content Governance | Employee | Request content, track the request, preview and approve before publishing |
| Appointment Booking | Employee | Book and manage appointments across multiple business units |
| My active items widget | Employee | All tasks, surveys and requests requiring action in one place |
| Cross-channel favorites | Employee | One-click access to frequently used internal and external sites |
| Guided Self-Service | Employee | Guided experiences for self-serve capabilities |
| Content engagement | Employee, Content author | Comments and reactions on news articles, engagement metrics |
| Organization chart | Employee, Manager | Find employees and understand team structure |
| Employee profile | Employee, Manager | View employees' work-related information |
| Approvals hub | Manager | Manage and approve requests from internal and external applications in one location |
| Integrated experience and service feedback | Manager | Quick feedback from employees on user or service experiences |
| Content templates | Content author | Templates for communications |
| Employee communications authoring | Content author | Rich content, news articles, tasks, notifications, surveys, social media messages |
| Campaigns | Content author | Multi-stage, multi-channel targeted campaigns |
| Content Analytics | Content author | Monitor and measure impact of EC content |

Add where the relevant apps are present: journeys, listening posts, learning posts, Manager Hub, microsites, Employee News, kiosk.

## Determining usage, not installation

Usage must come from evidence. Three sources, in descending confidence:

1. **Record counts** in the feature's tables. Zero records means unused regardless of what is installed.
2. **Presence on rendered pages** found in the Phase 5 crawl. A feature with records but no page placement is configured but not surfaced.
3. **Usage telemetry** from Usage Insights and `sp_log`. A feature that is placed and populated but never touched is the most commercially interesting finding of all.

Report unused Pro features as unrealized value. This is usually the section of the audit with the clearest commercial follow-through.

## Configuration workflow and role chain

The documented EC Pro setup sequence, useful for spotting an incomplete implementation:

1. System admin installs plugins and assigns roles.
2. Taxonomy admin configures the unified taxonomy, dynamic topic pages and quick links.
3. Employee Center admin configures the portal, widgets, action framework, employee profile, Recommended for you, Guided Self-Service and cross-channel favorites.
4. Content admin, engagement admin and content analytics admin configure employee communications features.
5. Content manager creates and publishes content and monitors performance metrics. Campaign manager assembles content into campaigns.
6. Employees use the portal.

An implementation that stops at step 3 is common and detectable: taxonomy and portal configured, communications features installed but with no content admin assigned and no published content.

## Supporting chain for features that fail silently

- **HR Core populated** is required for journeys. Journeys surface catalog items as tasks, and misconfigured HR Core produces silent failures.
- **Cross-scope Restricted Caller Access** records must show Allowed rather than Requested.
- **Role assignments** from the workflow above must actually exist on real users, not just be defined.

## Employee Slate

A new AI-first employee experience described as the advanced version of Employee Center Pro, powered by Moveworks or Now Assist, reusing Employee Center's tables. Launched in the May 2026 release with a mobile web version at launch and monthly capability drops thereafter. If present on the instance, it changes the roadmap conversation and should be noted, though it does not change the audit mechanics.
