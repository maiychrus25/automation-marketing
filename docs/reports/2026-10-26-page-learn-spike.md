# Daily Page suggestions: read-only identity spike

Status: **offline evidence only; live validation pending; unreleased**. Task 0 supplies fixtures for Task 4, not a production reader or a release approval. Controller rulings 10–13 supersede the brief's live-capture and commit steps.

## Evidence and privacy boundary

The only capture input was the controller's `page-learn-sanitized-evidence.json`. The controller inspected operator-supplied offline HTML and extracted allowlisted structure, replacing every private scalar before this task. This task did not open raw HTML, Downloads, credentials, browser profiles, or other capture files, and made no network, browser, Facebook, or AI calls.

The input records offline inspection of `me.html` and `homepage.html` using Python `HTMLParser` without JavaScript execution. Those filenames are provenance supplied by the controller, not files opened by this task. Both represented the **same active Page**. Homepage was that Page's news feed, not a personal-profile sample. Exactly **one top-level own-Page timeline story** was observed.

Every Page name, ID, category, description, URL, timestamp, count and post text below is a **synthetic example**, not real user data. Structure is offline-observed; synthetic scalar values provide deterministic tests. Raw captures contain session tokens and must never be committed.

| Fixture | Provenance and purpose |
|---|---|
| `src/__tests__/dailyBrief/fixtures/page-identity.html` | Observed current-user module plus menu/header/feed payloads, with their input nesting unchanged. Minimal non-executable HTML with `script[type="application/json"]`; the Relay envelope is minimized fixture scaffolding and cache labels are synthetic. |
| `src/__tests__/dailyBrief/fixtures/page-posts.json` | Exactly the input `feedData` object, including the full feedback nesting and synthetic cursor. No flattened or fabricated post schema. |
| `src/__tests__/dailyBrief/fixtures/person-identity.html` | **SYNTHETIC / NOT LIVE-VERIFIED**. No personal capture exists. Its matching actor explicitly has `is_profile_plus=false`, with no `delegate_page`. Actor location and personal classification are unverified assumptions for the future conservative contract. |

## (a) Page versus person: contextual identity evidence

Chosen source: **the loaded DOM's embedded JSON only**, using `script[type="application/json"]`. Parse JSON without executing scripts. No redirect URL, meta tag, visible-text selector, or live DOM timing was verified; none is an identity proof here. The synthetic header URL is a data field, not evidence of the actual `/me` redirect.

Path notation for the minimized HTML fixtures:

- `C = $.define[i]`, selected by `C[0] == "CurrentUserInitialData"`; current-user fields are `C[2].USER_ID`, `C[2].ACCOUNT_ID`, and `C[2].NAME`.
- `R = $.require[i]`, selected by `R[0] == "RelayPrefetchedStreamCache"`; each embedded data payload is `D = R[3][1].__bbox.result.data`. Menu, header and feed refer to the corresponding payload, not an unrestricted search through arbitrary objects. Array positions identify the fixture envelope; cache labels must not be treated as stable production selectors.
- `U = C[2].USER_ID = "100000000000101"` is the **active profile ID**; `C[2].ACCOUNT_ID = "100000000000001"` is different. Neither equality nor inequality with `ACCOUNT_ID` proves person or Page.
- `P = "200000000000201"` is the **delegated Page ID**, distinct from `U`. Persist `pageId=P`, not `U`, `ACCOUNT_ID`, a post ID, or a Relay story ID.

The observed Page evidence forms a contextual join:

| Payload | Exact paths and required context |
|---|---|
| Menu | `D.user.id == U` and `D.user.comet_profile_entity_menu.user.id == U`. The Page is `D.user.comet_profile_entity_menu.user.delegate_page.id == P`; its actor is `D.user.comet_profile_entity_menu.user.delegate_page.viewer.actor.id == U` with `.is_profile_plus == true`. |
| Header | `D.user.id == U` and `D.user.profile_header_renderer.user.id == U`; `D.user.profile_header_renderer.user.delegate_page.id == P`. Its `.__typename` is `User`, while `.delegate_page.is_business_page_active` is `false`: neither disproves Page identity. |
| Feed | `D.user.id == U`, with `D.user.delegate_page.id == P`. This is the Page's own timeline payload used below. |
| Homepage provenance | In the input's `homepageData`, `$.viewer.actor.id == U`, `$.viewer.actor.delegate_page_id == P`, and `$.viewer.actor.__typename == "User"`. This corroborates the same Page session; it is not a person sample and is not a fourth payload in the Page fixture. |

Conservative Task 4 contract: classify `page` only from matching current-actor evidence (`is_profile_plus=true`) linked to a consistent delegated Page identity in that active profile's context. Do not recursively choose the first Page object: menus, shared posts, and feeds may contain unrelated Pages. A Page field alone, `__typename == "User"`, URL shape, name, or `ACCOUNT_ID` equality is insufficient.

The person fixture proposes a separate, **unverified** case: its `C[2].USER_ID` is `"fixture-person-id"`; at `D.viewer.actor`, `.id` matches that active ID and `.is_profile_plus` is explicitly `false`. No delegated Page evidence is present. Its equal `ACCOUNT_ID` is deliberately incidental. Only an explicit matching false actor with no contradictory Page evidence permits the proposed `person` result; absence of Page fields alone does not. Missing actor flags, unmatched IDs, conflicting current-user modules, conflicting Page IDs, or simultaneous matching false actor and Page evidence mean **`unknown`**. An unrelated actor's false flag must not classify the current actor. No real personal-profile behavior is established by this fixture.

## (b) Page fields

Read fields only after joining the payload's active ID to `U` and delegated ID to `P`. Do not combine fields from unrelated or conflicting records.

| Field | Exact path | Synthetic fixture value |
|---|---|---|
| Page ID | Feed `D.user.delegate_page.id`; corroborated by menu/header paths above | `200000000000201` |
| Page name | Feed `D.user.delegate_page.name`; menu `D.user.comet_profile_entity_menu.user.delegate_page.name`; header `D.user.profile_header_renderer.user.name` | `Example Driving School` |
| Category | Feed `D.user.delegate_page.category_name` | `Driving school` |
| About | Feed `D.user.delegate_page.best_description.text` | `Driving lessons for beginners. Practical instruction and road safety.` |
| Profile URL | Header `D.user.profile_header_renderer.user.url` | `https://www.facebook.com/example-driving-school/` |

`C[2].NAME` also contains the synthetic Page name, but does not classify identity. No separate About-page navigation was performed or verified. Future storage keeps `about` to 1000 characters and post text to 500, per the spec; fixtures retain the supplied strings unchanged.

## (c) Available own-Page posts and engagement

Use the **already loaded embedded feed JSON**. The observed query **name** is `ProfileCometTimelineFeedQuery`, as recorded in the controller's provenance. No actual `friendly_name` request parameter, `doc_id`, request body, variables, or pagination behavior was verified. Do not invent them or issue a new GraphQL request. No scrolling, clicking, typing, or extra fetching is part of the chosen route. The synthetic `edges[*].cursor` is retained for structural fidelity; it does not establish working pagination.

In `page-posts.json`, `D` is the JSON root; in HTML it is the embedded `data` payload defined above. Require `D.user.id == U` and `D.user.delegate_page.id == P`. Candidate story boundary:

```text
S = D.user.timeline_list_feed_units.edges[*].node
```

Only these top-level `Story` nodes are candidates, and their own `S.actors[*].id` must identify the active Page. The observed actor is **`U`**, not `P`; a filter requiring actor ID to equal only the delegated Page ID would drop this story. Matching story actor to `U` is supported by the Page identity join above. A story from a stranger in the homepage news feed is not an own-Page sample. Never recursively collect nested stories, quoted/shared posts, their actors, messages, or feedback: those belong to another story and can contaminate ownership, text, and metrics. Shared-post variants were not captured, so their detailed schema remains unverified.

| Output | Exact path relative to `S` | Synthetic fixture value |
|---|---|---|
| Post ID | `S.post_id` | `300000000000301` |
| Relay story ID (not Page ID) | `S.id` | `fixture-story` |
| Text | `S.comet_sections.content.story.message.text` | `Check mirrors and signal before changing lanes.` |
| Time | `S.creation_time` | `1793000000` (epoch seconds); future `postedAt` in ms is `1793000000000` |
| Permalink | `S.permalink_url` | `https://www.facebook.com/reel/300000000000301` |

The feedback renderer is nested at this exact path:

```text
F = S.comet_sections.feedback.story.story_ufi_container.story.feedback_context.feedback_target_with_context.comet_ufi_summary_and_actions_renderer.feedback
A = F.adaptive_ufi_action_renderers[*].feedback
```

| Count | Exact field within `A` | Observed array position and synthetic value |
|---|---|---|
| Reactions | `A.reaction_count.count` | `F.adaptive_ufi_action_renderers[0].feedback.reaction_count.count = 12` |
| Comments | `A.comment_rendering_instance.comments.total_count` | `F.adaptive_ufi_action_renderers[1].feedback.comment_rendering_instance.comments.total_count = 3` |
| Shares | `A.share_count.count` | `F.adaptive_ufi_action_renderers[2].feedback.share_count.count = 2` |

Select renderer entries by their field, not an assumed stable ordering. Missing counts/time remain `null` under the future `PagePostSample` contract, rather than fabricated zeroes. The measured sample has text, time, URL and all three counts. The report does not establish completeness for other story types.

Return only currently available, matching top-level samples, capped at **10**. Exactly **one** own-Page story is supported by this evidence; do not duplicate or fabricate nine more, or claim these are the ten newest posts. If no qualifying stories are loaded, return no samples. Additional samples and ordering/completeness need future live validation.

## Verification and release limitations

Fixture checks parse the inert HTML with Python stdlib `HTMLParser` and JSON with `json.loads`; compare the Page module/menu/header/feed and standalone feed exactly to the sole sanitized input; verify the synthetic values, actor/delegate join, one-story boundary, and explicit synthetic person case; and reject non-allowlisted keys, token/tracking fields, or executable/external HTML. A second round exercises corrupted in-memory copies without modifying fixtures. Exact commands and captured outputs are in the ignored Task 0 report.

No production code, IPC, schema, version, release state, or dependencies are changed. Existing input nesting and the standard library are reused; only the requested evidence artifacts are introduced. Task 4's parser and browser integration are not implemented or tested here.

**Release limitations:** no live Facebook or macOS browser validation, no real personal-profile capture, no verified redirect/meta/visible-DOM identity heuristic, no verified GraphQL request or pagination, and only one own-Page story. Offline fixture validation must not be presented as live success. Planned 26.31.0 remains **unreleased** until deployment is authorized and validated under ruling 13. These fixtures support a conservative reader contract, not a claim that production Page/person classification is complete.

## Correction 2026-10-27 — observed outer transport envelope

The controller supplied a second, explicitly secret-free regression projection, `page-identity-nested-envelope.html`, preserving the offline-observed outer transport layer. No raw capture was opened. The earlier notation `$.define` / `$.require` described a **minimized inner projection**, not the complete observed script envelope. That omission caused the initial Task 4 reader to return `unknown` for the wrapped form. This dated correction supersedes that envelope notation; the historical evidence, payload boundaries and synthetic values above remain unchanged.

In the observed script JSON root, the entry is `["ScheduledServerJS", "handle", null, [{"__bbox": B}]]` at `$.require[0]`. The current-user module is at `B.define[i]`, where `B = $.require[0][3][0].__bbox`; Relay entries are at `B.require[i]`. Thus `C = B.define[i]`, `R = B.require[i]`, and each Relay payload still has `D = R[3][1].__bbox.result.data`. The existing `page-identity.html` fixture now preserves this outer layer; a structural comparison verified its inner projection equals the prior synthetic fixture exactly. No IDs, names, counts, timestamps, URLs or post content were replaced with real values. Root/minimized projection remains a separate regression constructed in memory.

Task 4 now unwraps only recognized `ScheduledServerJS.handle` transport entries through their argument `__bbox`, bounded at 4 transport levels and 100 envelopes; exceeding either bound returns `unknown` rather than accepting partial evidence. This is not a recursive search through arbitrary payload objects, Page/User objects, switchers or story actors. Nested/wide transport variants are synthetic robustness tests, not additional observed production layouts. Tests also preserve literal `<!--...-->` strings inside script JSON while excluding actual HTML comments.

This correction establishes an **offline-observed envelope only**. It does not verify wrapper delivery/timing in a live DOM, browser navigation, current Facebook behavior, a real personal profile, GraphQL requests or pagination. The original one-story and unreleased limitations still apply. Full/private offline-capture checks remain with the controller.

## Correction 2026-10-27 — realistic script count and finite budget (fix round 2)

The controller reports **176** valid `application/json` scripts in the privately inspected `me` capture and **241** in the homepage capture, before transport unwrapping. Only these counts were supplied; no private IDs, names, content or raw capture files were read for this fix. The initial **100-envelope** budget mentioned in the prior correction rejects normal observed input. The controller also reports that an in-memory change to 1024 allowed its private `me` check to identify a Page and one post; that is controller-reported offline evidence, not a live check performed by this task.

The current bound superseding the previous 100 is **1024 total envelopes**, counting both initial JSON roots and recognized unwrapped `__bbox` children. Depth remains **4**. Synthetic tests use 176 and 241 initial scripts with ordinary recognized wrappers and unrelated module/foreign-actor/switcher noise. At 241 roots plus one child per root, the test traverses **482** envelopes, leaving **542** envelopes of documented headroom. This model does not assert the private capture's exact wrapper count. Exactly 1024 envelopes remain acceptable; exceeding the bound at initial input or while unwrapping returns `unknown`, without accepting partial identity evidence. The hostile width case is recalibrated from 200 to **1025** branches; depth 4 succeeds and depth 5 is rejected. No trust/malformed check is relaxed and no fixture scalar changes.

These are synthetic size/boundary regressions based on controller-supplied counts only. Actual-capture revalidation and full checks remain with the controller; wrapper timing, navigation, person identity and pagination remain unverified live. No raw capture/Downloads/network/browser access or new dependency is part of this correction.
