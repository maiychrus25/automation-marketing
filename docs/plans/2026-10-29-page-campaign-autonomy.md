# Page Campaign Autonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho một Page vận hành campaign trong quyền chủ đã cấp, đăng qua scheduler hiện có, quan sát phản hồi có nguồn và điều chỉnh có giới hạn mà không phá luồng thủ công.

**Architecture:** Campaign có liên kết Page dài hạn, tách khỏi ownership bất biến của từng work. Receiver tạo grant trong transaction; runner dùng method hẹp; lịch tự động có reservation và authority bền vững được kiểm lại tới hàng rào gửi Facebook. Đo bài Page dùng nguồn post search hiện có, chỉ nhận khớp ID/actor chính xác; số liệu thiếu không tham gia tối ưu.

**Tech Stack:** TypeScript/Electron, SQLite/better-sqlite3, Jest; Python bridge dùng stdlib và phiên bản Python hiện có. Không thêm dependency, scheduler, dashboard hoặc nền tảng agent.

**Spec:** `docs/specs/2026-10-29-page-campaign-autonomy.md` — anh duyệt chuyển sang lập kế hoạch ngày 29/10/2026.

**Trạng thái:** Anh duyệt kế hoạch 29/10/2026; Tasks 1–8 đã qua review local. Broad review và một lượt sửa/scoped re-review F1 đã kết thúc, không còn finding trong diff sửa lỗi; **nghiệm thu tổng thể vẫn BLOCKED**, chưa phát hành hoặc bật quyền đăng thật. HEAD nền `823db94`, giữ toàn bộ dirty Phase A và prior tasks. Make/lint, randomized legacy `groupContactType` seeds 2707/3707, current-publish/firstComment, live identity/collector, receiver isolation/fresh-HOME auth và packaging vẫn blocked. UI không đổi (render N/A); không có bình luận độc lập hoặc ROI thực.

**Ghi chú triển khai Task 8 (không viết lại thân kế hoạch lịch sử):** suite mới `pageCampaignAutonomy.integration.test.ts` dùng registry/auth/SQLite/operations/scheduler/post task thật và pinned HTTPS/Python bridge, giả lập external browser/sender. Stress gồm 50 contender, 100 replay + 100 cancel, 7 ngày qua restart/DST; production wiring không cần đổi. Already-green cases là existing-behavior verification, không nhận là RED→GREEN. Actual publisher vẫn unconfirmed/collector unavailable; confirmed measurement/optimization là synthetic tách riêng. Hai vòng commands/build scratch phải bàn giao cả failure, không nhận compile/bundle là production package/obfuscator parity. Controller sở hữu review sau freeze.

**Kết quả local Task 8 trước final review (lịch sử):** hai matrix 28/28 (2707/3707, America/New_York), hai full chuẩn 125 suites/3156 tests, Python 361 mỗi vòng; TS/docs/diff exit 0. Hai full randomized vẫn lỗi legacy `groupContactType:48` (1 failed/3155 passed mỗi seed); Make build/test/lint exit 2. Hai compile/strip/bundle scratch exit 0, không installer/E2EE/native/obfuscator certification. 291 file UI/design/icon và native/repo outputs giữ hash. Transaction fault coverage gồm adapter `SQLITE_IOERR` trước transaction, trước promotion, sau reservation và response loss sau commit. Controller review/acceptance vẫn pending.

**Ghi chú sau final review — 29/10/2026, chưa phát hành:** F1 là public receiver poll giả định mọi event có `workId`; thêm đúng hai dòng phân loại campaign hint, không đổi API hoặc work recovery. Unit và pinned HTTPS/public-poll regression tái hiện `KeyError` trước sửa; scoped re-review xác nhận resolved, không còn finding trong diff sửa lỗi. Hai vòng sau sửa (2707/3707) mỗi vòng matrix 29/29, Python 363 và Jest chuẩn 125 suites/3157 tests; full randomized mỗi seed 1 failed/3156 passed (cùng lỗi legacy), Make mỗi lệnh exit 2, cả hai TS/docs/diff exit 0. Controller chạy độc lập lại các matrix/full suites/checks với cùng kết quả. Có diagnostic console.error/warn trong full Jest, không nhận output pristine. Code không drift qua verification; 538 native/output và 291 UI files giữ hash. Giữ nguyên các bước lịch sử bên dưới và mọi blocker ở dòng Trạng thái; không merge/commit/push/deploy, không xoá bằng chứng.

## Global Constraints

- Mặc định tự động tắt. Đề nghị đầu tiên: **7 ngày, tối đa 1 bài/ngày và 7 bài/grant**; không vượt giới hạn thấp hơn của daily brief. Lịch một lần tối đa 7 ngày tới, nằm trong hạn grant; không tự gia hạn hoặc tạo lịch lặp vô thời hạn.
- Ba lượt agent/ngày/Page xuyên mọi bước, lease 3.600.000 ms, cùng daily ledger và browser-job slot. Không nhân quota theo campaign/profile/work hoặc tạo tick agent thứ hai.
- Campaign thuộc đúng workspace/Page; work sau chỉ tham chiếu, không chuyển `page_work_resources.work_id`. Draft/media/video vẫn thuộc work gốc.
- `protectedWritesEnabled=false` giữ nguyên trên cấu hình thật. Chỉ fixture tạm được đặt true. Cấp grant là quyết định riêng của chủ Page, không phải hệ quả của việc duyệt spec/kế hoạch.
- Runner không tự cấp/gia hạn quyền, giả `owner`, dùng `confirm: true`, đổi dữ kiện confirmed hoặc bắt đầu render có phí. Quyền rộng legacy không được dùng để chạy chế độ tự động.
- Pause/thu hồi/đổi danh tính chặn effect mới; `uncertain` không retry mù và không trả quota. Không hứa exactly-once từ Facebook. Lịch owner không bị huỷ để nhường quota.
- Đo cùng Page/campaign/định dạng; cửa sổ 28 ngày, mốc 4.320 phút, tuổi snapshot 72–96 giờ, ít nhất 5 mẫu đầy đủ/lựa chọn và coverage ≥80%. Hoà/thiếu mẫu giữ kế hoạch; mỗi lượt đổi tối đa một yếu tố, ưu tiên nội dung rồi khung giờ.
- Null không phải zero. Lead không phải đơn. Doanh thu/ROI luôn unavailable khi chưa có nguồn giao dịch/chi phí; không yêu cầu khách nhập nguồn đã nói không có.
- Không bình luận độc lập trong kế hoạch này. Spec sau giữ khám phá mục tiêu mở, không bắt buộc danh sách URL/nhóm cố định. Giữ first comment dưới bài vừa đăng trong authority của nội dung đó.
- Không Facebook/Telegram/Claude/video thật, migration DB khách, timer thật, thay Downloads, đổi version/dependency, stage/commit/push/deploy hoặc hạ sandbox. Dev → test dev → build artifact → deploy chỉ khi được cấp phép riêng.
- Identifiers tiếng Anh; copy khách tiếng Việt. Không lưu/log cookie, token hoặc HTML thô, kể cả fixtures mới. Không thêm PII vào báo cáo/audit khi chỉ cần ID/tham chiếu.
- Mỗi task cập nhật `SYSTEM_DOCUMENTATION.md` và protocol/README nếu thay contract; constants có `docs-check`. Giữ thân tài liệu lịch sử, chỉ thêm trạng thái/ghi chú thực tế. Không sửa Make/lint ngoài scope để che blocker.
- TDD, review diff thật, hai vòng stress và full suites trước closeout. Không xoá test hay giảm assertion. Nếu phải đổi kỳ vọng test vì tính năng mới, giữ ca legacy cũ và thêm ca opt-in; không dùng thay kỳ vọng để che regression.

## Review Focus

1. **Scheduler tự tăng revision khi cập nhật nextRunAt/lastRunId:** không làm mọi bài tự động bị stale, nhưng sửa nội dung/file sau uỷ quyền phải bị chặn — Task 3–4.
2. **Fallback publish có await sau lần kiểm đầu, first comment là effect thứ hai:** revoke/đổi Page phải được kiểm lại trên browser đang đăng trước từng effect — Task 4.
3. **Crash sau gửi, khởi động lại, campaign bị xoá hoặc thiếu dòng authority:** không biến lịch managed thành legacy và không đăng lại — Task 1, 3–4.
4. **URL redirect/ID bị nhầm, bài mất quyền đọc, null counts và snapshot muộn:** không đoán match hoặc loại bài lỗi khỏi mẫu để làm coverage đẹp — Task 5–6.
5. **Thông báo grant/số liệu đến muộn sau prune work, revoke key hoặc đổi workspace A→B→A:** không lộ Page khác, không replay quyền cũ và không gửi lặp — Task 2, 7–8.

---

## 1. Phân rã file và điểm tích hợp đã khảo sát

| Trách nhiệm | File mới | File cũ được mở rộng tại task tương ứng |
|---|---|---|
| Model, proposal/link/grant | `src/models/pageCampaigns.ts`, `src/services/dailyBrief/PageCampaignStore.ts` | `src/models/pageOperations.ts`, `PageWorkStore.ts`, approval operations |
| Reservation/effect journal | `src/services/dailyBrief/PageCampaignExecutionStore.ts` | poster schema/store và lịch |
| Nghiệp vụ scoped | `src/services/dailyBrief/pageCampaignOperations.ts` | `pageWorkOperations.ts`, `pageOperationMethods.ts`, `controlAuthorization.ts`, IPC wiring |
| Hàng rào thực thi | `src/services/dailyBrief/pageCampaignExecution.ts` | scheduler/service, `postToTargets.ts`, first comment, TaskDeps, IPC |
| Đo lường/điều chỉnh | `src/services/dailyBrief/pageCampaignMetrics.ts`, `src/services/facebookPoster/PageCampaignTracker.ts` | timer tracking hiện có, kết quả đăng, research/store hiện có |
| Runner/receiver | Không thêm package/process mới | `tools/maihub-bridge/maihub_bridge.py`, test và tài liệu hiện có |

Các store mới chỉ quản lý persistence của một domain nhỏ; operations giữ orchestration và quyền. Không thêm interface Repository/Factory/engine workflow. Tests mới đặt trong `src/__tests__/dailyBrief/` hoặc `src/__tests__/facebookPoster/` cùng mẫu `memoryDb()` hiện có.

Điểm phải giữ trong triển khai:
- `pageApprovalOperations.ts:99–298` dùng cùng DB handle và ticket consumption transaction; mở rộng union OwnerAction, không xây hệ duyệt thứ hai.
- `pageWorkOperations.ts:91–207` và `controlAuthorization.ts:81–110` đang yêu cầu campaign owner cùng work; chỉ thay nhánh campaign bằng kiểm liên kết Page, không đổi `owned()` chung.
- `FacebookPosterStore.updateSchedule` hiện CAS với `draft = 1`; schedule đã promote cần CAS riêng. Scheduler tăng `revision` cả khi đổi bookkeeping; dùng fingerprint cấu hình/content riêng cho authority.
- `FacebookPosterScheduler` kiểm campaign khi fire/pump, nhưng legacy callback fail-open và manual bypass tồn tại. Guard autonomy phải fail-closed riêng, không sửa hành vi legacy để làm task dễ hơn.
- `postToTargets` có hai đường click publish, retry trước submit và first comment sau submit; guard ở `startRun` hoặc `enterCritical` một lần là chưa đủ.
- `PostTracker`/`statsReport` cũ dành cho nhóm; null được cộng thành zero ở report cũ. Không sửa ý nghĩa report legacy; tạo projection Page riêng.

## 2. Hợp đồng giao tiếp dùng xuyên các task

Task 1 định nghĩa các kiểu sau trong `src/models/pageCampaigns.ts`; phần mở rộng đặt ở task sở hữu nó. Không truyền DB path/clock/principal từ payload runner.

- `CampaignScope = Pick<PageContext, 'workspaceId' | 'pageId' | 'profileId'>`.
- `CampaignPolicy = { startsAt: number; expiresAt: number; maxPostsPerDay: number; maxPostsTotal: number; allowedMinutes: number[]; timeZone: string; actions: Array<'schedulePost' | 'updateScheduledPost'> }`. Timestamp safe integer, `startsAt < expiresAt`; phút local unique 0–1439, không rỗng. Defaults 7 ngày/1/7; giờ mặc định lấy brief đã cấu hình và hiện rõ cho chủ. Thời hạn/quota khác chỉ đến từ proposal chủ xác nhận, không tự mở rộng; horizon lập lịch luôn 7 ngày.
- `CampaignProposalInput = { name: string; goal: string; policy: CampaignPolicy; campaignId?: string; expectedCampaignRevision?: number }`; tạo mới không nhận campaignId, gia hạn bắt buộc cả ID/revision. Tên/goal dùng validation campaign hiện có. ID proposal server cấp, revision bắt đầu 1, CAS update.
- `CampaignProposal = CampaignScope & { id: string; workId: string; revision: number; input: CampaignProposalInput; status: 'pending' | 'accepted' | 'cancelled'; createdAt: number; updatedAt: number }`.
- `PageCampaignLink = CampaignScope & { campaignId: string; revision: number; managed: true; proposalId: string; createdAt: number; deletedAt: number | null }`. `profileId` là profile được chọn khi tạo, không quyền chuyển owner. Tombstone ID không được nhận grant mới.
- `CampaignGrant = CampaignScope & { id: string; campaignId: string; campaignRevision: number; revision: number; policy: CampaignPolicy; status: 'active' | 'revoked'; receiverKeyId: string; confirmedAt: number; confirmationRef: string }`. Hết hạn tính theo clock hiện tại, không chờ timer cập nhật status. Public view bỏ receiverKeyId/confirmationRef; không trả ticket.
- `CampaignDraftSelection = { variant: 'A' | 'B' | 'C' | 'D' | 'E'; contentRevision: string; factIds: string[] }`. `contentRevision` là hash server của bộ text/variants/comment/media hashes, không tin giá trị runner tự khai. `factIds` phải tồn tại và confirmed; thêm/sửa dữ kiện được tham chiếu làm stale basis.
- `CampaignScheduleInput = { draftId: string; expectedDraftRevision: number; campaignId: string; grantId: string; expectedGrantRevision: number; runAt: number; variant: CampaignDraftSelection['variant']; factIds: string[] }`.
- `CampaignScheduleUpdateInput = Omit<CampaignScheduleInput, 'draftId' | 'expectedDraftRevision'> & { expectedScheduleRevision: number; content?: { text: string; variants?: string[]; comment?: string; mediaIds?: string[] } }`. Không có `content` thì giữ nội dung; có thì là snapshot thay thế đầy đủ qua validation nháp (comment/media bỏ trống nghĩa rỗng). Không đổi draft/work owner bằng update.
- `CampaignExecution = CampaignScope & { scheduleId: string; workId: string; campaignId: string; grantId: string; grantRevision: number; runnerKeyId: string; authorityFingerprint: string; selection: CampaignDraftSelection; plannedDate: string; actualDate: string | null; status: 'reserved' | 'submitting' | 'posted' | 'uncertain' | 'cancelled'; runId: string | null; resultId: number | null; revision: number }`. Retry trước submit giữ reservation; sau submit không trở lại reserved khi chưa có bằng chứng.
- `CampaignObservation = { resultId: number; postId: string; postUrl: string; pageId: string; campaignId: string; publishedAt: number | null; observedAt: number; milestoneMinutes: 60 | 1440 | 4320; sourceRef: string; status: 'measured' | 'unavailable'; reason: string; reactions: number | null; comments: number | null; shares: number | null }`. Snapshot immutable; không public method nhận counts.
- `CampaignReport = { campaignId: string; pageId: string; from: number; to: number; published: number; eligible: number; measured: number; coverage: number | null; totalEngagement: number | null; uniqueLeads: number; lastObservedAt: number | null; missingReasons: string[]; finance: { status: 'unavailable'; reason: 'missing_financial_source' } }`. Report tổng là phần đã đo với coverage rõ; nếu có bài eligible thiếu count, `totalEngagement=null`, không giả tổng đầy đủ.
- `CampaignDecision = { id: string; campaignId: string; grantId: string; grantRevision: number; kind: 'keep' | 'variant' | 'time'; before: string | number | null; after: string | number | null; observationRefs: string[]; sampleSizes: Record<string, number>; coverage: Record<string, number>; reason: string; createdAt: number }`. ID/fingerprint và bằng chứng do server lưu, không để runner nộp kết luận đã đo.

Method mới là prefix `pageCampaigns.*`: `list`, `get`, `propose`, `schedule`, `updateSchedule`, `cancelSchedule`, `collect`, `report`, `optimize`. Read `list/get/report` cho runner/receiver đúng Page. Mutations chỉ runner có lease/gate, trừ thao tác OwnerAction qua receiver. `collect` dùng lease và browser slot nhưng không tự gọi agent; receiver không điều khiển browser. Không mở `campaigns.*`, `posts.stats`, `events.wait` toàn workspace cho scoped keys.

Error giữ envelope hiện có: `FORBIDDEN`, `CONFLICT`, `LIMIT_EXCEEDED`, `NEEDS_REVIEW`, `INVALID_PARAMS`. ID ngoài scope trả FORBIDDEN; không lộ tồn tại. Mọi danh sách/báo cáo/events lọc theo Page/profile/workspace cả trước và sau await/cache.

## Task 1: Persistence Page–campaign và proposal/grant

**Files:** Create model ở §2, `src/services/dailyBrief/PageCampaignStore.ts`, `src/__tests__/dailyBrief/PageCampaignStore.test.ts`. Modify `SYSTEM_DOCUMENTATION.md`.

**Interfaces:** `PageCampaignStore(db: SqlDatabase)` có `ensureSchema(): void`, `getLink(campaignId: string): PageCampaignLink | null`, `list(scope: CampaignScope): PageCampaignLink[]`, `listProposals(scope: CampaignScope): CampaignProposal[]`, `getProposal(id: string): CampaignProposal | null`, `saveProposal(scope: CampaignScope, lease: WorkLease, input: CampaignProposalInput, expectedRevision: number | null, now: number): CampaignProposal`, `getGrant(id: string): CampaignGrant | null`, `listGrants(campaignId: string): CampaignGrant[]`. `acceptProposal(scope, proposalId, expectedRevision, confirmation: PageConfirmation & { receiverKeyId: string }, now): { campaignId: string; grantId: string }` và `revokeGrant(scope, grantId, expectedRevision, now): void` là internal trusted methods, không runner endpoints. `acceptProposal` dùng validation/store campaign chung, không gọi scheduler trong transaction.

- [ ] **1. Viết test đỏ** với `memoryDb`, clock cố định và poster schema thật; assertions:
  - `proposalDoesNotCreateRunnableCampaign`: `expect(poster.listCampaigns()).toHaveLength(0)` sau proposal; không sinh schedule.
  - `acceptIsAtomicAndReplayStable`: ném lỗi giữa campaign/link/grant → cả ba không có dòng mới; replay qua operation sau này trả cùng ID. Một proposal đã accepted không tạo campaign thứ hai.
  - `crossWorkReferenceDoesNotTransferOwner`: tạo link, hai work cùng Page đọc được; `expect(works.getResourceOwner(ref)).toEqual(originalOwner)`; Page khác bị từ chối.
  - `pruneDoesNotRemoveCampaignOrGrant`: prune work sau 30 ngày → `expect(store.getLink(id)).not.toBeNull()` và grant/audit còn; tombstone không thể tái nhận.
  - `staleRevisionAndSilentDatabaseFailure`: stale CAS/DB read bị rỗng bất thường → throw, không báo success; không ghi đè dữ liệu đã có.
- [ ] **2. Chạy đỏ:** `npm test -- --runInBand src/__tests__/dailyBrief/PageCampaignStore.test.ts`; fail vì hành vi chưa có, không chấp nhận environment failure làm RED.
- [ ] **3. Implement** bảng additive `page_campaign_links`, `page_campaign_proposals`, `page_campaign_grants`, cùng DB handle; unique campaign link và proposal→accepted result. Dùng `changes()`/count checks như PageWorkStore vì adapter DB có đường trả rỗng khi lỗi. Một pending proposal/work, update CAS thay vì tạo vô hạn proposal qua retry; tìm lại proposal cũ qua list khi đổi work.
- [ ] **4. Chạy xanh** cùng lệnh + `src/__tests__/dailyBrief/PageWorkStore.test.ts src/__tests__/facebookPoster/campaigns.test.ts`; xác nhận tên test campaign thực tế trước chạy nếu repo đổi. Không đổi ownership/schema của work hiện có.
- [ ] **5. Review diff + docs-check**, lưu kết quả trong ledger scratch. Không commit khi chưa được phép.

## Task 2: Uỷ quyền từ chủ và Control API scoped

**Files:** Modify `src/models/pageOperations.ts`, `src/services/dailyBrief/pageApprovalOperations.ts`, `src/services/control/pageOperationMethods.ts`, `src/services/control/controlAuthorization.ts`, `src/services/control/controlEvents.ts`, `src/services/control/ControlStore.ts`, `electron/ipc/controlApiIpc.ts`, `SYSTEM_DOCUMENTATION.md`, `docs/protocol/maihub-control-protocol.md`. Create `src/services/dailyBrief/pageCampaignOperations.ts`, `src/__tests__/dailyBrief/pageCampaignOperations.test.ts`; extend `pageApprovalOperations.test.ts`, `src/__tests__/control/controlAuthorization.test.ts`, `src/__tests__/control/pageOperationMethods.test.ts`, `src/__tests__/control/controlWiring.test.ts`.

**Interfaces:** thêm OwnerAction `{kind:'grantCampaign'; pageId; proposalId; expectedProposalRevision}` và `{kind:'revokeCampaignGrant'; pageId; grantId; expectedGrantRevision}` (IDs string, revisions number). `createPageCampaignOperations(deps)` có `list(pageId:string): { campaigns: PageCampaignLink[]; proposals: CampaignProposal[] }`, `get(pageId:string,campaignId:string): { campaign: PageCampaignLink; grants: Array<Omit<CampaignGrant,'receiverKeyId'|'confirmationRef'>> }` và `propose(lease:WorkLease,input:CampaignProposalInput,expectedRevision:number|null): CampaignProposal`; `deps` giữ DB/context/clock/assertCurrent từ PageOperationRequest và principal đã xác thực. `ControlStore.findActiveKeyById(id: string): { id: string; policy?: ScopedKeyPolicy } | null` không lộ hash/secret. Authorization resources thêm callback kiểm campaign link/proposal/grant trên captured DB, không dùng mutable singleton.

- [ ] **1. Viết test đỏ** cho HTTP registry thật và approval operations:
  - `runnerCannotGrantOrRenew`: runner gọi prepare/confirm hoặc nhét grant/owner fields vào proposal → `FORBIDDEN`/`INVALID_PARAMS`; số grant không đổi.
  - `ownerConfirmationCreatesCampaignAndConsumesTicketTogether`: fingerprint đề nghị/identity/business basis/múi giờ khớp → đúng một campaign/link/grant/ticket consumption. Confirm lặp cùng update trả `{replayed:true}`.
  - `changedProposalOrWrongSenderRejects`: đổi revision/khung giờ/quota hoặc sender/reply → reject; “ok” không có ticket không tạo grant.
  - `scopeIsCheckedBeforeCacheAndAfterAwait`: revoke key hoặc A→B→A trong request/cache-hit → FORBIDDEN, không result/event của Page khác.
  - `revokedGrantCannotBeResurrected`: gia hạn tạo grant mới qua proposal đã duyệt, không đổi lịch cũ sang grant mới âm thầm; revoke không xoá lịch owner.
- [ ] **2. Chạy đỏ:** `npm test -- --runInBand src/__tests__/dailyBrief/pageCampaignOperations.test.ts src/__tests__/dailyBrief/pageApprovalOperations.test.ts src/__tests__/control/controlAuthorization.test.ts src/__tests__/control/pageOperationMethods.test.ts`.
- [ ] **3. Implement** union/schema/snapshot/apply/authorization ở cả method registry và runtime pre-cache; không so expectedProposalRevision với revision hồ sơ business như các action cũ. Fingerprint bind chính proposal/link/policy và identity hiện tại. Grant transaction dùng Task 1 và consume ticket cùng connection. `revoke` đồng thời đánh dấu huỷ reservation chưa gửi khi Task 3 có mặt; side effect đang submitting chỉ thành uncertain, không trả quota. Public projections bỏ confirmationRef/receiverKeyId; events chỉ ID/status/revision, re-project từ link bền ngay cả khi work đã prune.
- [ ] **4. Nối** capabilities thêm `pageCampaigns: 1` chỉ khi toàn bộ runtime liên quan đã đăng ký; default false không đổi. `pageWork.events` thêm projection campaign cho receiver mà không mở global events; read-after-event/list là nguồn sự thật. Giữ các old method role và unknown-field rejection.
- [ ] **5. Chạy xanh** các test trên + `controlWiring.test.ts`, `ControlApiServer.test.ts`, `IdempotencyCache.test.ts`, `ControlStore.test.ts`; docs-check và diff review. Không thêm Settings/UI để cấp grant.

## Task 3: Nháp scoped, promotion và quota bền vững

**Files:** Create `src/services/dailyBrief/PageCampaignExecutionStore.ts`, `src/__tests__/dailyBrief/PageCampaignExecutionStore.test.ts`. Modify model Task 1, `pageCampaignOperations.ts`, `pageWorkOperations.ts`, `pageOperationMethods.ts`, `controlAuthorization.ts`, `src/services/facebookPoster/schema.ts`, `FacebookPosterStore.ts`, `drafts.ts`, `scheduleUpdate.ts`, `campaignOperations.ts`, `src/models/facebookPoster.ts`, `electron/ipc/facebookPosterIpc.ts`, các test nháp/lịch/campaign hiện có và `SYSTEM_DOCUMENTATION.md`.

**Interfaces:** `PageCampaignExecutionStore(db, clock=systemClock)` có `get(scheduleId): CampaignExecution|null`, `reserve(input: CampaignExecution, now:number): CampaignExecution`, `cancel(scheduleId,expectedRevision,now):void`, `beginSubmit(scheduleId,runId,now):CampaignExecution`, `settle(scheduleId,outcome:'posted'|'uncertain',resultId:number|null,now):void`. Mọi hàm internal, cùng connection với poster. Operations thêm `schedule(lease:WorkLease,input:CampaignScheduleInput): Promise<{scheduleId:string;revision:number}>`, `updateSchedule(lease:WorkLease, scheduleId:string, expectedExecutionRevision:number, input:CampaignScheduleUpdateInput): Promise<{scheduleId:string;revision:number}>`, `cancelSchedule(lease:WorkLease,scheduleId:string,expectedExecutionRevision:number):void`. Khi update, `expectedScheduleRevision` là revision row hiện tại; không cho đổi sang draft khác. Nội dung thay thế phải qua validation/media/facts hiện có và tạo contentRevision/fingerprint mới trong cùng transaction với reservation. Task 4 sẽ cấp guard trước gửi.

- [ ] **1. Viết test đỏ**, mở rộng fixture draft hiện có:
  - `campaignCanSpanWorkButDraftCannot`: work mới dùng campaign link hợp lệ; draft/media của work cũ không được sửa; nhánh legacy owner campaign vẫn dùng quy tắc cũ khi chưa có link.
  - `variantsRoundTripAndBindContent`: save/get scoped giữ 2–5 biến thể theo validation cũ; đổi text/comment/media bytes → fingerprint khác; gửi contentRevision giả bị từ chối.
  - `promotedContentUpdateIsAtomic`: update nội dung đúng work/grant và CAS → `expect(updated.selection.contentRevision).not.toBe(before.selection.contentRevision)`; media sai/facts chưa confirmed/stale CAS → row và reservation giữ nguyên, không gọi draft-only update để né kiểm.
  - `twoReservationsCannotSpendOneSlot`: hai connection cùng SQLite tạm tranh quota 1 → `expect(winners).toHaveLength(1)`; hai grant không tạo quota 2. 7 reservation thành công/grant, lần 8 bị chặn.
  - `cancelAndRetryReleaseExactlyOnce`: cancel trước gửi lặp 10 lần chỉ trả một reservation; submitting/uncertain vẫn chiếm quota qua restart.
  - `ownerScheduleKeepsPriority`: lịch thủ công hiện có chiếm slot → schedule autonomy reject; `expect(ownerAfter).toEqual(ownerBefore)`.
  - `missingAuthorityFailsClosed`: row đánh dấu autonomy nhưng thiếu execution/grant bị chặn, không trở thành owner; schedule bookkeeping đổi không làm fingerprint nội dung đổi.
- [ ] **2. Chạy đỏ:** `npm test -- --runInBand src/__tests__/dailyBrief/PageCampaignExecutionStore.test.ts src/__tests__/dailyBrief/pageWorkOperations.test.ts src/__tests__/dailyBrief/pageCampaignOperations.test.ts`.
- [ ] **3. Implement** `page_campaign_executions` + reservation uniqueness theo schedule; thêm `authority_kind` vào schedule với default `owner`, chỉ service tin cậy ghi `autonomy`, không nhận từ API input. Giữ idempotency key work/draft/revision/grant ổn định, transaction gồm reservation + promote + execution record. `approveDraft` dùng lại nghiệp vụ validation/promotion, không dùng owner ticket/event `draft.approved` giả; emit event autonomy riêng sau commit.
- [ ] **4. Implement** reference campaign riêng trong auth/save/get; thêm `variants?: string[]` vào PageDraftInput/projection/schema/hash. Server giữ identity/profile/target; kiểm factIds confirmed và snapshot basis. Prompt phải chỉ dùng confirmed cho giá/cam kết/vùng phục vụ/khả năng đáp ứng; nếu nội dung cần dữ kiện thiếu thì giữ nháp review, không tự xác nhận. Metadata factIds không tự chứng minh mọi câu tự do là đúng: tests phải phân biệt provenance enforcement với chất lượng ngôn ngữ, không công bố bộ lọc chân lý hoàn chỉnh.
- [ ] **5. Implement** CAS cho schedule đã promote, riêng với draft CAS hiện có. Revoke huỷ work/reservation gắn campaign chưa gửi và chặn reclaim work autonomy đã huỷ; không vô hiệu research/đề nghị Phase A hoặc grant của campaign khác cùng Page. Thêm ca `revokedWorkCannotBeReclaimed` với `expect(reclaimedCampaignWork).toBeNull()` nhưng work đọc/đề xuất độc lập vẫn theo quyền cũ. Fingerprint authority hash nội dung/biến thể/media bytes/profile/Page/campaign/grant/basis/runAt, loại bookkeeping nextRunAt/lastRunId. Chỉ update schedule do cùng work tạo, reserved, có grant; nếu work đã kết thúc thì runner điều chỉnh các lịch mới của work kế tiếp, không chiếm owner cũ. Lệnh chủ sửa hợp lệ giữ nguyên nhưng vô hiệu authority tự động cũ; không biến edit chung thành gia hạn quyền.
- [ ] **6. Quota/time checks:** local date dùng LocalClock, timeZone dùng injected `Intl.DateTimeFormat().resolvedOptions().timeZone`; mismatch dừng. Page daily cap là min của brief và daily caps của các grant active cho Page, tính chung reservations/posted/uncertain. Đếm lịch owner sẽ chạy/ngày và kết quả owner đã chạy, không double-count cùng run; unresolvable Page của lịch cùng profile làm chặn autonomy thay vì đoán. Hạn cấp grant đếm lifetime của grant; chuyển ngày kiểm lại actualDate, không chạy bù qua ngày. Dùng `nextRunAt`, timing parser hiện có để tính occurrence lịch lặp owner, không sửa lịch đó.
- [ ] **7. Chạy xanh** test task + toàn bộ `src/__tests__/facebookPoster/` và `src/__tests__/dailyBrief/`; review shared CRUD/IPC callers, docs-check. Chưa cho scheduler gửi khi chưa có guard Task 4: lịch autonomy phải fail-closed nếu guard chưa được wire.

## Task 4: Guard trên browser đang đăng và recovery

**Files:** Create `src/services/dailyBrief/pageCampaignExecution.ts`, `src/__tests__/dailyBrief/pageCampaignExecution.test.ts`. Modify `src/services/facebookPoster/{FacebookPosterScheduler,FacebookPosterService,postToTargets,types,firstComment}.ts`, `electron/ipc/facebookPosterIpc.ts`, `electron/ipc/controlApiIpc.ts`, `src/__tests__/facebookPoster/{FacebookPosterScheduler,FacebookPosterService,postToTargets,firstComment}.test.ts`, `SYSTEM_DOCUMENTATION.md`.

**Interfaces:** model Task 1 thêm `AutonomyExecutionGuard` với `assertCurrent():void`, `beforeEffect(page: Page, kind:'publish'|'firstComment'):Promise<void>`, `settle(outcome:'posted'|'uncertain',resultId:number|null):void`; `Page` dùng type Playwright đang được module dùng. Guard là object main-process, không serializable và không nằm trong StartParams của API. Factory `createPageCampaignExecutionGuard(deps, scheduleId:string, runId:string): AutonomyExecutionGuard` lấy execution từ DB, kiểm live key IDs/policy/gate/grant/link/context và identity trong cùng browser đang chạy.

- [ ] **1. Viết test đỏ**:
  - `bookkeepingRevisionDoesNotInvalidateContentAuthority`: scheduler đổi nextRunAt/lastRunId vẫn chạy một lần; sửa text/file/mode/target/campaign thì zero publish clicks.
  - `revocationDuringFallbackAwaitPreventsSubmit`: revoke trong fallback selector await → `expect(publishClicks).toBe(0)`; chạy riêng cả direct locator/fallback.
  - `identityChangeUsesPostingBrowser`: learned Page cũ đúng nhưng actor thực sai/unknown → zero publish; không mở browser thứ hai để chứng minh identity.
  - `firstCommentHasOwnBarrier`: revoke sau publish → một bài posted, zero comment submits; không đánh dấu bài failed để retry toàn bài.
  - `crashAfterSubmitKeepsReservation`: mất process giữa click và lưu result → restart uncertain, `expect(secondPublishClicks).toBe(0)`; crash trước barrier có thể retry reservation cũ.
  - `autonomyCannotUseManualCampaignBypass`: paused/archived/missing campaign hoặc callback ném → zero effect; test bypass/fail-open legacy cũ vẫn giữ.
- [ ] **2. Chạy đỏ:** `npm test -- --runInBand src/__tests__/dailyBrief/pageCampaignExecution.test.ts src/__tests__/facebookPoster/FacebookPosterScheduler.test.ts src/__tests__/facebookPoster/postToTargets.test.ts`.
- [ ] **3. Implement** guard fail-closed tại scheduler fire/pump, service start và từng publish click thực. Trong `pageCampaignExecution.ts`, `readPostingIdentity(page: Page): Promise<PageIdentityRead>` đọc trạng thái cấu trúc hiện tại, dùng lại `parseIdentityHtml` ở `src/services/dailyBrief/pageIdentity.ts` khi đủ bằng chứng, không navigate khỏi composer hoặc mở browser phụ. Không dùng composer displayName làm Page ID; current HTML thiếu numeric actor/delegate Page evidence thì unknown và zero publish, không thêm nguồn giả để test xanh. Parser cho trang profile chưa chứng minh được actor trên composer thật: ghi riêng gate live identity chưa kiểm chứng. Hàng rào sau awaits và ngay trước effect ghi `submitting` bền vững; một synchronous final authority check đứng sát thao tác gửi. Không có await nghiệp vụ không được guard chen giữa check cuối và click. Giữ retry trước submit hiện có, không retry sau `uncertain_after_submit`.
- [ ] **4. Nối** guard tới first comment, gồm click submit riêng; cancellation/quyền hết hạn không được biến thành post failure. Guard live đọc key bằng ID và scope bất biến; không giữ closure principal đã sống qua hết request. Workspace switch retirement/check generation dùng lifecycle hiện có, không tạo vòng import controlApiIpc↔facebookPosterIpc. Huỷ/đợi owned job an toàn trước đóng DB; request đã gửi không thể thu hồi thì lưu uncertain.
- [ ] **5. Recovery** xử lý journal trước `failInterruptedRuns`/queue reload: submitting→uncertain; reserved chưa gửi chỉ xét lịch tương lai hoặc trong grace hiện có và cùng ngày; không revive lịch missed. Đối soát từ result/run/post ID bằng chứng đúng scope, không tìm bằng tên/nội dung gần giống để xác nhận đã đăng. Thiếu bằng chứng giữ uncertain/needs review. Payload/title thay đổi ở thời điểm queue phải bị fingerprint chặn.
- [ ] **6. Chạy xanh** task + `FacebookPosterService.test.ts`, first-comment tests, `src/__tests__/app/workspaceIpc.test.ts`, `controlWiring.test.ts`; kiểm toàn bộ callsites TaskDeps/startRun không làm legacy cần grant. Docs-check và review diff trước Task 5.

## Task 5: Collector bài Page và báo cáo không bịa số liệu

**Files:** Create `src/services/facebookPoster/PageCampaignTracker.ts`, `src/services/dailyBrief/pageCampaignMetrics.ts`, `src/__tests__/facebookPoster/PageCampaignTracker.test.ts`, `src/__tests__/dailyBrief/pageCampaignMetrics.test.ts`. Modify model/store Task 1, execution store, `src/services/facebookPoster/{FacebookPosterService,PostTrackScheduler}.ts`, `src/__tests__/facebookPoster/PostTrackScheduler.test.ts`, `pageCampaignOperations.ts`, `pageOperationMethods.ts`, `controlAuthorization.ts`, `electron/ipc/facebookPosterIpc.ts`, `electron/ipc/controlApiIpc.ts`, `SYSTEM_DOCUMENTATION.md`, protocol.

**Interfaces:** `PageCampaignTracker(deps)` có `collect(scope:CampaignScope,campaignId:string,assertCurrent:()=>void):Promise<{checked:number;measured:number;unavailable:number}>`, `cancel():void`, `whenIdle():Promise<void>`, `isRunning():boolean`. Deps dùng ResearchService `reserveSearch`/`whenIdle`/`cancelOwned`, ResearchStore trên cùng DB và shared browser slot; clock/guard do main cung cấp. `buildCampaignReport(input:{scope:CampaignScope;campaignId:string;from:number;to:number},db:SqlDatabase):CampaignReport` trong metrics; mọi rows lấy từ DB có source đã kiểm. Store thêm `recordObservation(observation:CampaignObservation):void`, `listObservations(scope,campaignId,from,to):CampaignObservation[]`, chỉ internal.

- [ ] **1. Viết test đỏ**:
  - `pagePostRegistersDurableMeasurement`: managed posted result có ID/URL → một row gắn Page/campaign/result; group tracking hiện có không đổi. Không mặc nhiên bật tracking Page legacy ngoài opt-in.
  - `exactPostAndAuthorMatchOnly`: search trả nhiều bài/actor, URL query lẫn duplicate → `expect(observations.map(x => x.postId)).toEqual([expectedPostId])` chỉ khi exact normalized postId + author Page khớp; match bằng title/keyword/place bị từ chối.
  - `unsupportedLookupDoesNotTruncateOrSearch`: URL chuẩn hoá dài hơn 100 ký tự → `expect(result.reason).toBe('unsupported_lookup_url')` và `expect(startedScans).toHaveLength(0)`; không sửa validation search chung.
  - `missingCountsRemainUnknown`: `[0,0,0]` là đo đầy đủ tổng 0; `[10,null,2]` cho `totalEngagement=null`, measured không tăng.
  - `missingDeletedLateStayInDenominator`: 10 bài đủ tuổi, 8 có đủ dữ liệu → `coverage===0.8`; bài lỗi/mất quyền không bị bỏ khỏi eligible. Snapshot 97 giờ được báo cáo nhưng không dùng so sánh 72–96 giờ.
  - `leadWonIsNotRevenue`: hai comment tham chiếu cùng lead ID chỉ đếm một; `finance` luôn `{status:'unavailable',reason:'missing_financial_source'}`; không thêm đơn/currency/ROI giả.
  - `trackingUsesOneFairTimer`: fake hai nguồn luôn due, bốn tick rảnh → `expect(startedKinds).toEqual(['group','page','group','page'])`; busy → không thêm job; không có managed link thì lịch group và `autoEnabled` giữ kỳ vọng cũ.
- [ ] **2. Chạy đỏ:** `npm test -- --runInBand src/__tests__/facebookPoster/PageCampaignTracker.test.ts src/__tests__/dailyBrief/pageCampaignMetrics.test.ts`.
- [ ] **3. Implement** registry kết quả managed và observation table Page riêng; không nhét Page vào `groupUrl` hay sửa null semantics của statsReport cũ. Source là **post search bằng canonical URL**, qua scoped `reserveSearch({source:'posts',query:canonicalUrl,origin:'api'},ownership)` hiện có, gọi `reserved.start()` rồi `whenIdle()` trước đọc rows. Chỉ URL Facebook hợp lệ đã chuẩn hoá, dài 1–100 ký tự theo giới hạn search; không cắt chuỗi để vừa hoặc bỏ giới hạn. URL không biểu diễn được trong giới hạn → unavailable với `unsupported_lookup_url`. Kết quả cần exact post ID/URL, `authorKind === 'page'`, `authorId === expectedPageId` và source scan/profile; không suy author từ `placeId`. Thiếu chứng cứ → unavailable, không fallback sang title/time. Dùng parser cấu trúc đang có; không phát minh GraphQL doc ID/Page timeline endpoint. Fixture search hiện có chỉ chứng minh fields, không chứng minh URL-query lookup trên Page thật.
- [ ] **4. Nối** mốc 60/1.440/4.320 phút vào `PostTrackScheduler` 15 phút đang có: thêm optional deps `runDueCampaignTracking?: () => boolean` (true nghĩa đã nhận một job), mặc định vắng giữ legacy; chỉ nhận job Page thuộc link managed khi key/scope/identity/gate hợp lệ và slot rảnh. Khi cả Page và group cùng đến hạn, luân phiên một job mỗi tick để không bên nào bị bỏ đói; `autoEnabled` tiếp tục điều khiển group tracking cũ, không tự sửa cấu hình đó. Một scan/result/mốc có ID ổn định, crash/retry đối soát scan trước tạo mới; giới hạn truy vấn dùng limit thấp nhất đủ tìm exact hit và hard cap hiện có, không quét vô hạn. Chỉ một job dùng browser slot, cancel/resume bounded theo DB, không timer thứ hai hoặc agent invocation để poll. Callback captured workspace; request collect từ runner cần lease nhưng timer nội bộ không lấy lease agent. Collector không được khiến lịch đăng của owner đói slot; busy thì đợi tick sau, không tăng attempts.
- [ ] **5. Implement report** provenance, kỳ đo, lastObservedAt, coverage và missingReasons. PublishedAt nguồn run/result/ID đã xác nhận, không lấy thời điểm đọc làm thời điểm đăng; unknown publishedAt không vào cohort tuổi. Lead join dùng exact canonical URL/ID hiện có, không text matching; không sao chép hội thoại. Read observations/events phải còn scope kể cả work đã prune.
- [ ] **6. Chạy xanh** task + `PostTracker.test.ts`, `src/__tests__/research/`, các test leads và campaign. Chỉ có synthetic/mock thì ghi `live collector verification pending`; chưa xác minh được truy vấn thật tìm bài thì không claim collector live hoàn chỉnh. Nếu nguồn thực không trả exact match, báo unavailable và khóa optimize là hành vi đúng, không giảm điều kiện để ép pass. Docs-check/review.

## Task 6: Quyết định tối ưu có bằng chứng và áp dụng có giới hạn

**Files:** Modify `src/services/dailyBrief/pageCampaignMetrics.ts`, `PageCampaignExecutionStore.ts`, `pageCampaignOperations.ts`, `pageOperationMethods.ts`, model Task 1, `SYSTEM_DOCUMENTATION.md`, protocol. Extend `pageCampaignMetrics.test.ts`, `pageCampaignOperations.test.ts`.

**Interfaces:** `chooseCampaignAdjustment(input:{observations:CampaignObservation[];current:CampaignDraftSelection;currentMinute:number;allowedMinutes:number[];now:number},cohorts:CampaignCohort[]): CampaignDecisionInput` là pure. Task này định nghĩa `CampaignCohort={kind:'variant'|'time';key:string;format:'text'|'image'|'video';contentRevision:string;eligibleResultIds:number[];observationRefs:string[]}` và `CampaignDecisionInput=Omit<CampaignDecision,'id'|'campaignId'|'grantId'|'grantRevision'|'createdAt'>`. `optimize(lease:WorkLease,campaignId:string,draftId:string,expectedDraftRevision:number,grantId:string,expectedGrantRevision:number):Promise<{decision:CampaignDecision;scheduleId:string|null}>` lưu quyết định; áp dụng qua nghiệp vụ Task 3, không raw SQL sửa params.

- [ ] **1. Viết test đỏ** bằng dữ liệu cấu trúc và clock, assertions:
  - `fiveSamplesAndEightyPercentBoundary`: mỗi lựa chọn 5/6 hợp lệ được xét; 4/5 → keep dù coverage 80%; 5/7 → keep dù có 5 mẫu; 8/10 → được xét.
  - `ageWindowAndLookbackAreExact`: tại 72h/96h hợp lệ; 72h−1ms/96h+1ms không; ngoài 28 ngày không. Mỗi result dùng tối đa một observation mốc, không đếm nhiều lần polling là nhiều bài.
  - `tiesAndIncompleteCandidatesKeep`: điểm bằng nhau hoặc một lựa chọn thiếu metric/mẫu/coverage → `expect(decision.kind).toBe('keep')`, không winner theo ID.
  - `oneFactorOnly`: khi cả variant/time có dữ liệu, `kind==='variant'`; khi variant không đủ nhưng time đủ thì chỉ đổi giờ. So sánh variant giữ cùng slot/format, so sánh giờ giữ cùng content revision/format; không trộn các yếu tố khác.
  - `contentRevisionAndGrantStayBound`: nội dung A đổi hash không gộp cohort cũ; revoke/stale giữa choose/apply → không có schedule mutation; Page/campaign khác không nhập mẫu.
- [ ] **2. Chạy đỏ:** `npm test -- --runInBand src/__tests__/dailyBrief/pageCampaignMetrics.test.ts src/__tests__/dailyBrief/pageCampaignOperations.test.ts`.
- [ ] **3. Implement** pure arithmetic average reactions+comments+shares khi cả ba là safe nonnegative count, cỡ mẫu/coverage mỗi lựa chọn. Thiếu toàn bộ pair so sánh không gọi một lựa chọn đơn là winner. Scope/campaign lọc trong operation trước pure function; server tính cohort từ immutable run snapshots, không nhận cohorts/counts từ runner. Giữ format khác và content revision khác riêng.
- [ ] **4. Apply** chỉ draft/lịch reserved của work đang có lease, grant hiệu lực, giờ đã cho phép. Draft mới phải có `plannedAt` hợp lệ để gọi `schedule`; thiếu ngày thì lưu quyết định `keep` với `missing_planned_time`, không tự chọn ngày. Lịch đã promote gọi `updateSchedule` với đúng schedule/execution revision và giữ các trường ngoài một yếu tố đang đổi. Chọn biến thể gửi thực tế bằng server-owned selection snapshot, không sửa nhãn A–E cũ bằng đổi thứ tự text để giả thắng. `keep` vẫn có reason và evidence; pilot 7 bài thường keep. Decision + mutation/reservation trong transaction; replay cùng inputs trả cùng decision, không thêm quota hoặc sửa lịch owner. Lưu before/after cho rollback trong tương lai; không thay kết quả đã đăng.
- [ ] **5. Chạy xanh** task + `src/__tests__/facebookPoster/bestTimes.test.ts`, các test variants và scheduler; docs-check. Ghi rõ không causal inference/ROI hoặc bảo đảm tăng trưởng.

## Task 7: Bridge, runner và receiver Telegram

**Files:** Modify `tools/maihub-bridge/maihub_bridge.py`, `tools/maihub-bridge/tests/test_bridge.py`, `tools/maihub-bridge/README.md`, protocol và `SYSTEM_DOCUMENTATION.md`. Không thêm listener/poller Telegram hay service khác.

**Interfaces:** giữ `build_tools(describe_result)`, `protected_brief_tick(client,run_agent_fn,clock,state_path)`, `ProtectedWatcher.deliver/poll`, `handle_owner_update(client,update,pending)`. Công cụ lấy từ server describe đã lọc, không hardcode quyền mới trong Python. Thêm validation/render cho OwnerAction Task 2 và kết quả methods §2; không nhận JSON lệnh tuỳ ý từ tin nhắn.

- [ ] **1. Viết test đỏ** trong các class protected hiện có:
  - `test_campaign_proposal_requires_bound_owner_reply`: message proposal hiện đúng Page/mục tiêu/thời hạn/giờ/1 bài mỗi ngày/7 bài; wrong sender/reply/expired revision không gọi confirm.
  - `test_runner_uses_campaign_tools_without_owner_credentials`: allowlist/prompt có scoped tools, không `drafts.approve`/`campaigns.*` rộng, secret receiver không nằm env/MCP/state/agent input.
  - `test_grant_does_not_add_agent_budget`: các campaign cùng Page vẫn một claim và tối đa 3 agent invocation/ngày; reconcile/report polling không gọi thêm agent.
  - `test_campaign_notifications_survive_lost_event`: bỏ event hoặc prune work rồi restart, receiver list/get/report vẫn khôi phục trạng thái; send-once key chứa workspace/Page/campaign/revision/kỳ báo cáo; uncertain delivery không gửi lại mù.
  - `test_finance_unavailable_is_not_zero`: copy không có 0% ROI/số đơn giả; thiếu mẫu báo “chưa đủ dữ liệu để điều chỉnh”; không tự gia hạn grant.
- [ ] **2. Chạy đỏ:** `python3 -m unittest discover -s tools/maihub-bridge/tests -v`; xác định tên ca mới thất bại do feature thiếu, không do môi trường.
- [ ] **3. Implement** mở rộng protected prompt theo quyền server trả về: không grant thì nháp/đề nghị; có grant mới dùng schedule/collect/report/optimize. Dữ liệu research là dữ liệu không tin cậy, không instructions; nội dung thương mại chỉ confirmed facts, thiếu thì needs review. Giữ fresh HOME/XDG/env/UID model/sandbox hiện có, không đổi provider hoặc đăng nhập thật.
- [ ] **4. Receiver** prepare→persist intent→send_once→bind message như hiện có; confirm từ authenticated update mới tạo grant. Proposal, revoke, trạng thái và báo cáo dựa read model scoped; không dùng lời AI làm proof chủ đã đồng ý. Grant expiry/revoke phải hiện lý do, không tự chuyển sang legacy mode.
- [ ] **5. Chạy xanh** toàn bộ Python suite, không skip. Cập nhật hướng dẫn staging và runtime blockers: entrypoint receiver VPS thật, OS-user/file/env/MCP separation, CLI auth fresh HOME chưa được test ở đây. Không cài timer hoặc gọi send thật. Docs-check và diff review.

## Task 8: Composition, hai vòng stress và bàn giao local

**Files:** Create `src/__tests__/dailyBrief/pageCampaignAutonomy.integration.test.ts`; reuse cấu trúc pinned loopback HTTPS/runtime/Python bridge/SQLite của `pageOperations.integration.test.ts` bằng test helper chỉ khi thực sự chia sẻ setup. Modify `SYSTEM_DOCUMENTATION.md`, protocol, `tools/maihub-bridge/README.md`, `README.md`, trạng thái spec/kế hoạch. Không sửa UI hoặc history của Phase A.

**Interfaces:** không thêm production API. Test real registry/auth/store/operations/scheduler/post task với fake browser/provider và fake authenticated sender; không mock luôn kết quả dịch vụ cần kiểm.

- [ ] **1. Viết composition tests trước** rồi chạy RED cho thiếu wiring: chủ xác nhận proposal→campaign/grant→claim→nháp→reservation→scheduler→posted result→observation→report; hai Page độc lập, hai profile một Page; expired/revoked/key corrupt/wrong actor/default gate false; manual owner vẫn đăng theo quy tắc cũ. Test lượt ngày sau dùng campaign cũ không đổi resource owner.
- [ ] **2. Thêm ma trận stress:** 50 contender cùng quota một slot; 100 replay/cancel; 7 ngày fake-clock qua restart, lease stale, đổi ngày/múi giờ, DST giữ cùng zone; inject fault tại trước/sau transaction, trước publish, sau submit, trước result write, giữa fallback await và first comment. Assert số effect, reservation, DB rows, event projection và không lộ secret. Các số stress là kích thước test, không hạn mức sản phẩm.
- [ ] **3. Hoàn tất wiring còn thiếu** tại đúng seam sở hữu, không tạo đường test-only trong production. Vòng đầu chạy toàn bộ ma trận + commands dưới đây; vòng hai fresh DB/state và các thứ tự race khác có seed cố định, lại chạy toàn bộ. Không reuse kết quả Phase A làm bằng chứng mới.

```bash
make build
make test
make lint
npm test -- --runInBand
python3 -m unittest discover -s tools/maihub-bridge/tests -v
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.electron.json
node scripts/check-docs.js
git diff --check
```

- [ ] **4. Build artifact kiểm chứng vào scratch**, không đổi output repo/native dependencies: `npx tsc -p tsconfig.electron.prod.json --outDir "$SCRATCH/campaign-build-round-N"` và `npx vite build --outDir "$SCRATCH/campaign-renderer-round-N"` với SCRATCH là scratchpad phiên hiện hành, N=1/2. Kiểm script strip-console thật trước khi tái dùng vào output scratch nếu cần đối chiếu production pipeline; không sửa script hoặc chạy `npm run production` như lối tắt vì nó rebuild native/packaging. Ghi rõ đây chưa là installer/native/E2EE build đã chứng nhận.
- [ ] **5. Báo các gate thật:** Make targets hiện thiếu, mỗi lệnh có thể exit 2; ghi nguyên đầu ra, không thay bằng typecheck rồi gọi lint pass. Không có live Page collector/receiver/packaging chứng nhận thì trạng thái vẫn blocked tương ứng. Không bắt “Build succeeded” bằng cách in chuỗi đó thủ công. Nếu UI không đổi, không bịa hai vòng browser test; ghi N/A và hash kiểm UI giữ nguyên. Nếu có UI thay đổi được duyệt thêm, phải đọc DESIGN.md và chạy cả hai vòng desktop/mobile light/dark.
- [ ] **6. Một broad review cuối** trên diff so với baseline task mới, không review lại toàn Phase A dirty diff. Sửa findings trong scope, scoped re-review, xác nhận regression cụ thể qua suites. Controller đọc actual diff, docs-check và đối chiếu manifest trước/sau; không chỉ tin báo cáo agent.
- [ ] **7. Cập nhật trạng thái local**: nêu task đã làm, tests/output, UI hoặc live chưa kiểm, Make/lint/packaging/receiver còn blocked. Giữ protectedWritesEnabled=false; không tự tuyên bố release. Chưa triển khai bình luận độc lập và chưa đo ROI phải vẫn được ghi rõ.

## 3. Phân công và thứ tự thực thi

- Sau khi anh duyệt kế hoạch: dùng `superpowers:subagent-driven-development`; mỗi task một implementer rồi task review spec + quality. Cùng store/IPC/schema được chạm xuyên tasks nên **không chạy các writer song song**; nghiên cứu/check read-only độc lập có thể chạy song song. Không hỏi lại phương thức subagent đã chọn.
- Thứ tự: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8**. Task 5 chỉ cần 1–4 ổn định; không làm optimizer trước khi có observation contract. Không mở tool capability hoàn chỉnh tới runner trước khi runtime guard/collector/report đã nối; các method chưa đủ deps phải từ chối, không stub success.
- Baseline là working tree hiện có, không chỉ HEAD. Mọi brief phải kèm global constraints, interfaces task, snapshot diff đầu task và file report trong scratchpad. Không dùng git worktree từ HEAD mà bỏ mất Phase A chưa commit; việc chọn isolation phải bảo toàn toàn bộ baseline và tuân thủ consent đã có, không tự commit/stash/reset.
- Ledger plan-specific ở scratchpad, không tạo thư mục debug trong repo. Agent không tự spawn reviewer, không commit; controller giao review sau report. Bàn giao không gọi completion nếu chỉ có mock đo lường hoặc quyền vận hành chưa được xác minh.

## 4. Đối chiếu spec trước bàn giao kế hoạch

| Spec | Task triển khai và bằng chứng |
|---|---|
| §1–3 mục tiêu/ranh giới/tái dùng | Global constraints, file map, Task 7–8; bình luận/ROI không bị nhận vơ |
| §4 Page/campaign bền vững | Task 1–3: cross-work reference, prune, tombstone, legacy compatibility |
| §5 grant/receiver/gate | Task 1–2, 4, 7: transaction, pre-cache auth, credential isolation, revoke |
| §6 quota/effects/recovery | Task 3–4, 8: atomic reservations, last-mile identity, uncertain, timezone, shared slot |
| §7 số liệu có nguồn | Task 5: exact ID/actor, null/coverage, nguồn thiếu, leads |
| §8 học từ quan sát | Task 6: 28 ngày/72–96 giờ/5 mẫu/80%, tie/one-factor, immutable snapshots |
| §9 thông báo/tài chính | Task 5, 7: dedup Telegram, missing finance, không raw secrets/PII |
| §10 tương thích/rollback | Task 1, 3–4, 8: owner schedules giữ nguyên, disable không mất dữ liệu, không downgrade binary mù |
| §11–12 kiểm chứng/gates | Task 8 và thứ tự thực thi; hai vòng evidence, chưa live/deploy |

**Rollback local:** chỉ gỡ đúng diff của task mới sau khi nhìn target và được yêu cầu; không reset toàn working tree. Runtime rollback là revoke/disable lịch autonomy ở điểm an toàn và giữ journal; không xóa bảng hay hạ binary không hiểu authority. Bản kế hoạch này không cho phép bật tự động hoặc phát sinh chi phí.
