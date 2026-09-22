# Consolidated Table and Object Inventory

Confidence is marked. Anything not marked high should be verified on the target instance before a query depends on it.

## Service Portal (high confidence)

| Table | Purpose |
|---|---|
| `sp_portal` | Portal record. Audit root |
| `sp_page` | Page. **No portal reference. Pages are global** |
| `sp_container` | Container, references parent `sp_page` |
| `sp_row` | Row, references container |
| `sp_column` | Column, references row. Bootstrap sizing |
| `sp_instance` | Widget instance |
| `sp_instance_link` | Link instance |
| `sp_instance_menu` | Menu instance |
| `sp_instance_carousel` | Carousel instance, slides in related list |
| `sp_instance_table` | Table instance |
| `sp_instance_vlist` | Simple List instance |
| `sp_widget` | Widget definition |
| `sp_dependency` | Dependency grouping |
| `m2m_sp_dependency_js_include` | Dependency to JS include join |
| `sp_ng_template` | Angular ng-template |
| `sp_js_include` | JS include, ordered |
| `sp_css` | CSS include / stylesheet |
| `sp_angular_provider` | Angular provider or service |
| `sp_theme` | Theme |
| `sp_rectangle_menu` | Menu container |
| `sp_rectangle_menu_item` | Menu item |
| `sp_page_route_map` | Route map. Check scope, some are system-wide |
| `sp_search_source` | Search source, Zing model only |
| `sp_rel_widget_clone` | Widget clone relationships |
| `sp_log` | Portal statistics |
| `sp_rectangle` | Widget / rectangle relationship |

## Employee Center (verify table names on instance)

The Australia documentation describes these as **forms** and does not consistently name their tables. Resolve actual names by filtering `sys_db_object` for the `sn_ex_sp`, `sn_ex_emp_fd`, `sn_hr_sp` and `sn_ex_sp_gd_help` scopes, plus checking the unscoped global tables noted below.

**Corrected twice, 2026-09-11 (see `14-open-questions.md`, items 1 and 7).** A first test on a fresh PDI concluded `sn_ect` is "not a real scope" — that conflated "owns no `sn_ect_`-prefixed tables" (true) with "the scope doesn't exist" (false, corrected on a second instance where it was found installed and active, v28.2.5, "Employee experience taxonomy"). **The part that matters for table lookups is still correct**: do not filter `sys_db_object` for a `sn_ect_` prefix, since it owns none of its own tables either way. Taxonomy and topic content live on unscoped global tables instead: `taxonomy`, `topic`, `taxonomy_content_configuration`, `m2m_connected_content`, `m2m_sp_portal_taxonomy`. But DO include `sn_ect` when inventorying installed scopes/apps (`sys_scope`, `sys_store_app`) — a fixed, enumerated scope list that omits it will misreport the app chain, and it is one of the apps genuinely present. Guided Self-Service is a real, separately scoped app, `sn_ex_sp_gd_help` ("Guided Self-Service in Employee Center"), with `sn_ex_sp_gd_help_process` (referencing `sys_pd_process_definition`, i.e. Process Designer) as its main table and `sn_ex_sp_gd_help_m2m_process_topic` linking a process to a topic. Also seen installed: `sn_ex_sp_notifs` ("Notifications for EC").

Objects to locate: Taxonomy, Topic, Connected Content, Quick Link, External Link, Featured Content, Block content, Link content, Footer, Footer Menus, Menu Item, Employee Profile, Employee Profile Header Configuration, Employee Profile portal configuration, Activity Configuration, Activity Configuration Detail, Approvals experience, Enhanced Requests Experience, Guided Self-Service, Overview section, Portal notification configuration, Portal notification content, Trigger conditions, Tab widget mapping, Schedule appointment, Location Consent, Website configuration, Topic metrics.

Scoped apps: `sn_ex_sp`, `sn_hr_sp`, `sn_ex_emp_fd`, `sn_ex_sp_pro`, `sn_ex_sp_gd_help`, `sn_ect`, `sn_ex_sp_notifs`.

## Next Experience / UI Builder (high confidence)

Relevant only if the portal turns out to be a UIB experience rather than a Service Portal, or if adjacent workspaces are in scope.

`sys_ux_page_registry`, `sys_ux_macroponent`, `sys_ux_screen`, `sys_ux_event`, `sys_ux_data_broker`, `sys_ux_client_script_include`, `sys_ux_children_slot`, `sys_ux_composite_data_template`.

## Search

| Object | Table | Confidence |
|---|---|---|
| Search Application | `sys_search_context_config` | High |
| Search Profile | `ais_search_profile` | High |
| Indexed Source | `ais_datasource` | High |
| Search Source | verify `ais_*` prefix | Medium |
| Genius Result config | verify `ais_*` prefix | Medium |
| Synonyms / dictionaries | verify `ais_*` prefix | Medium |
| Search events / analytics | `sys_search_event`, `sys_search_result_clicked`, `sys_search_signal_event`, `sys_search_signal_result_event`, `ais_query_statistics`, `ais_rag_search_event` | High. Confirmed present on a live instance (open question 3), though empty on both instances checked so far |
| Legacy Zing text index | `ts_index`, `ts_query`, `ts_index_*` | High. Not AI Search tables |

## Catalog (high confidence)

`sc_catalog`, `sc_category`, `sc_cat_item`, `sc_cat_item_producer`, `sc_cat_item_guide`, `sc_cat_item_wizard`, `item_option_new`, variable sets, catalog client scripts, catalog UI policies, catalog and category joins.

## Knowledge (high confidence)

`kb_knowledge_base`, `kb_category`, `kb_knowledge`, knowledge blocks, article templates, translations, versions.

## Security and content control (high confidence)

`user_criteria`, available-for and not-available-for joins across catalog, KB, topics and content, `sys_security_acl`, `sys_user_role`, `sys_user_has_role`, `sys_ui_message` (inactive portal messages).

## Customization and upgrade (high confidence)

`sys_update_xml`, `sys_update_version`, `sys_metadata`, `sys_scope`, `sys_package`.

Upgrade History, Upgrade Console and Upgrade Monitor are UI console names, not table names. The tables behind them **are** Table-API reachable with admin — confirmed 2026-09-11, see open question 4b in `14-open-questions.md`. Add to the inventory:

`sys_upgrade_history` ("System Upgrades", one row per upgrade) and `sys_upgrade_history_log` ("Upgrade Details", one row per file, carrying `disposition`). `sys_node_upgrade_history` is a further candidate. The Table API call must carry the `X-UserToken` header, per `13-data-access.md`.

Reachability was confirmed on one instance and one release, so the tiered fallback in `09-customization-upgrade.md` still stands for engagements where Tier A fails.

## Plugins and store apps

`com.glide.service-portal.user-criteria`, `com.snc.knowledge_serviceportal`, `sn_ex_sp`, `sn_hr_sp`, `sn_ect`, `sn_ex_emp_fd`, `sn_ex_sp_pro`, `sn_ex_sp_gd_help`, `sn_ex_sp_notifs`, `sn_ca`, `sn_cd`, `sn_hr_integr_fw`, `sn_ja`, `com.sn_hr_core`, `com.sn_hr_lifecycle_ent`, `sn_lp`, `sn_lnp`, `sn_mh`, `com.glide.cms` and `com.glide.cms.extensions` (deprecating in the C release).

## Roles

`sp_admin`, `esc_admin` / `sn_hr_sp.esc_admin`, `taxonomy_admin`, `content_admin`, `sn_cd.content_manager`, `sn_jny.admin`, `ais_admin`, `search_application_admin`, `admin`.
