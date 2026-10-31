# Page Operations Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho bot chuẩn bị nội dung cho từng Page bằng trí nhớ có nguồn, quyền hẹp và công việc có thể tiếp tục sau lỗi, rồi bàn giao đúng phiên bản nháp cho khách duyệt.

**Architecture:** Mở rộng SQLite, Control API và daily-brief runner hiện có; không thêm agent framework hoặc scheduler. MaiHub cưỡng chế quyền và lưu liên kết kết quả, VPS chỉ suy luận. Receiver Telegram giữ quyền xác nhận ở tiến trình/danh tính hệ điều hành khác; tích hợp receiver thực tế là cổng nghiệm thu riêng, không được suy ra từ unit test.

**Tech Stack:** TypeScript, Electron/React, better-sqlite3, Jest, Playwright hiện có; bridge Python 3.6+ chỉ dùng stdlib.

**Spec:** `docs/specs/2026-10-27-page-operations-foundation.md` — bản viết đã được duyệt ngày 27/10/2026.

**Trạng thái:** Anh đã duyệt và yêu cầu bắt đầu triển khai ngày 27/10/2026; đang triển khai local, chưa phát hành. Nền khảo sát: `823db94`, local 26.32.0 chưa phát hành.

## Global Constraints

- Pilot 1–3 Page; giữ giới hạn 10 daily brief/workspace; tối đa 10 hồ sơ kinh doanh/workspace, 100 thông tin/hồ sơ; `value` ≤ 2.000, `reason` ≤ 1.000, `sourceRef` ≤ 500 ký tự. Chạm giới hạn trả lỗi, không tự xoá.
- Hồ sơ khoá bằng `pageId` trong workspace. Một `primaryProfileId` đã chọn cho một Page; hai profile cùng Page không tạo hai bộ nhớ/hai lượt tự động. Mơ hồ thì chặn và hỏi chủ Page, không xoá/tắt brief cũ.
- Mỗi fact giữ đúng các trường ở spec §6.2. `observed`/`hypothesis` không phải `confirmed`; chỉ receiver tin cậy được xác nhận và gắn `confirmedAt`/`confirmationRef`. Ghi bằng `expectedRevision`.
- Ba lượt gọi agent/ngày/brief, tổng qua mọi bước. Poll trạng thái không tiêu lượt. Dùng lease 3.600.000 ms hiện có; token `claimedAt` phải tăng khi claim lại, kể cả clock bằng hoặc lùi.
- `pending | running | waiting | needs_review | completed | failed | cancelled`; `waiting` chỉ có `waitFor: video`. Một việc chưa kết thúc/Page; `needs_review` cũng chặn việc mới. Lưu nháp và liên kết xong là `completed`, không giữ việc để chờ duyệt.
- Giữ việc kết thúc 30 ngày; không prune việc chưa kết thúc và không xoá nguồn/nháp/video/lead khi prune nhật ký. Side effect không rõ kết quả → đối soát hoặc `needs_review`, không retry mù.
- Runner không duyệt, đăng, sửa/bật lịch, gửi CRM, cấp khoá, giả chủ Page hoặc tự bắt đầu render có thể tính phí. Luồng video khách yêu cầu, desktop approval và clients legacy vẫn giữ.
- Không có dữ liệu doanh thu: không tạo số đơn, doanh thu, lợi nhuận, tỷ lệ chốt, ROI; không bắt khách cung cấp số liệu không có. Nhận định phải tách quan sát/giả thuyết/chưa biết, không suy ra mua hàng từ lead.
- Không có tự bình luận độc lập, trả lời inbox, tương tác giả, quảng cáo hoặc thuật toán đánh giá chiến dịch trong đợt A. Đợt B/C có spec riêng.
- Không dependency mới; identifiers tiếng Anh, thông báo khách tiếng Việt. Không lưu/log cookie, token hoặc HTML thô trong facts, công việc, audit, test hay Telegram.
- Dev trước; chỉ DB tạm khi test. Không Facebook/Telegram/AI/video thật, migration dữ liệu khách, timer thật, push/deploy hoặc đổi version trong việc lập kế hoạch. Triển khai production sau này chỉ bằng artifact đã build và có phép riêng.
- UI giới hạn ở cấp khoá/phạm vi trong Settings hiện có, theo `DESIGN.md`; không dashboard mới. Hai vòng UI đều kiểm desktop/mobile, light/dark, bàn phím, tràn ngang/chồng chữ.
- Mỗi task thay API/schema/hành vi phải cập nhật `SYSTEM_DOCUMENTATION.md`, protocol/README liên quan và docs-check cùng thay đổi. Chỉ commit khi anh cho phép; bước commit dưới đây không tự cấp quyền commit/push. Không sửa lại lịch sử spec, chỉ trạng thái và ghi chú thực tế.

## Review Focus

1. **Hai profile cùng Page hoặc profile đổi Page giữa lượt:** không chạy trùng, không chuyển trí nhớ/nháp sang Page mới — Task 1, 2, 5, 7.
2. **Khoá scoped dùng cache/ID lồng/media global để vượt quyền:** mọi đường HTTP phải từ chối trước đọc cache/tệp, kể cả thu hồi giữa lượt — Task 3, 5, 7.
3. **Agent chết quanh side effect, video vượt lượt/ngày, event/media hết hạn:** phục hồi ID cũ, không tạo lại nháp/render, không tốn lượt chỉ để poll — Task 2, 5, 8.
4. **Khách duyệt nháp cũ, “ok” mơ hồ, giả sender hoặc runner đọc được secret receiver:** không duyệt; chế độ ghi không bật khi thiếu bằng chứng cách ly — Task 6, 8, 9.
5. **Nguồn bị xoá/mâu thuẫn, bộ nhớ đầy hoặc thiếu doanh thu:** giữ confirmed fact, trả xung đột/giới hạn rõ, báo thiếu bằng chứng thay vì bịa kết quả — Task 1, 7, 8.

---

## File structure và quyết định giao tiếp

| Khu vực | File mới | File hiện có cần mở rộng |
|---|---|---|
| Mô hình, bộ nhớ | `src/models/pageOperations.ts`, `src/services/dailyBrief/PageBusinessStore.ts` | Không đổi khoá `DailyBrief` |
| Công việc, liên kết, xác nhận | `src/services/dailyBrief/PageWorkStore.ts` | `DailyBriefStore.ts` chỉ thêm phối hợp chế độ mới |
| Quyền API | `src/services/control/controlAuthorization.ts` | `ControlStore.ts`, `ControlApiServer.ts`, `ControlMethods.ts`, `IdempotencyCache.ts`, `PairingTickets.ts` |
| Cấp khoá | `src/ui/components/settings/ControlKeyScope.tsx` | Settings/PairingPanel, preload, IPC declarations, `controlApiIpc.ts` |
| Điều phối có chủ sở hữu | `src/services/dailyBrief/pageWorkOperations.ts` | Research, draft, video/media và IPC tương ứng |
| Phê duyệt | `src/services/dailyBrief/pageApprovalOperations.ts` | Draft store/revision; không thay desktop thành Telegram |
| Method/lifecycle | `src/services/control/pageOperationMethods.ts` | `dailyBriefIpc.ts`, `controlApiIpc.ts`, `workspaceIpc.ts` |
| VPS | Không tạo package/service framework | `tools/maihub-bridge/maihub_bridge.py`, tests và README hiện có |

Tên file hiện có trong bảng là trong thư mục tương ứng; Files của từng task dưới đây ghi đường dẫn đầy đủ. Không tách lớp Repository/Factory hay tạo bảng CRM thứ hai.

### Hợp đồng chung

- `PageAssignment = { pageId: string; profileIds: string[] }`; `ControlPrincipal` là union `{ kind: 'legacy'; keyId: string }` hoặc `{ kind: 'page_runner' | 'page_receiver'; keyId: string; workspaceId: string; assignments: PageAssignment[] }`. Không dùng `keyName` làm identity. Nhánh `page_receiver` còn bắt buộc `ownerChatId: string`, `ownerSenderId: string` (Telegram IDs, validate chuỗi số nguyên không mất precision); runner không có hai field này. Policy của một khoá bất biến: đổi quyền bằng khoá mới/thu hồi khoá cũ.
- `PageContext = { workspaceId: string; dbPath: string; pageId: string; profileId: string }`, do máy chủ tạo. `assertCurrent(): void` kiểm workspace/switch flag, khoá còn hiệu lực và quyền hiện tại; gọi lại trước side effect và sau mỗi await trước ghi kết quả. Không tin workspace/profile do bot khai.
- `PageBusiness`/`PageFact` lấy các trường từ spec §6.2; thêm `enabled: boolean` (mặc định `false`) và `protectedSince: number | null` (mặc định `null`) cho chuyển giao chế độ mới. `PageFactInput` chỉ cho `observed | hypothesis`, `sourceType: page | research`; không có trường xác nhận. `PageWork` có đủ trường spec §8 và `waitFor: 'video' | null`.
- `WorkLease = { workId: string; claimedAt: number }`. `WorkStep` lưu `{ workId, stepKey, requestHash, status: 'intent' | 'succeeded' | 'uncertain', resourceKind, resourceId }`; `stepKey` ổn định, `requestHash` khác trên cùng step là xung đột. Không chấp nhận đường dẫn tệp từ runner.
- `PageDraftInput = { id?: string; expectedRevision?: number; name?: string; plannedAt?: number | null; text: string; mediaIds?: string[]; comment?: string; campaignId?: string | null }`; mode/profile/targets do server lấy từ context, không nhận `params` hoặc `mediaPaths` từ API mới. `PageResearchInput = { kind: 'search'; keywords: string[] } | { kind: 'group_feed'; groupIds: string[] }`; một nguồn/scan cho mỗi work trong A. `PageDraftView = Omit<PageDraftInput, 'expectedRevision'> & { id: string; revision: number }`. Task 5 thêm các kiểu này vào model; update nháp có id bắt buộc expectedRevision, create không nhận nó.
- `PageResourceRef = { kind: 'research' | 'video' | 'draft' | 'media' | 'campaign'; id: string }`. Liên kết gồm workspace/Page/work; không coi riêng `origin: bot` hoặc `profileId` là chứng cứ sở hữu. Kết quả mới được service liên kết; tài nguyên cũ chỉ receiver/owner tin cậy được gắn sau kiểm tra.
- `OwnerAction` là union đóng: `confirmFact`, `setPrimaryProfile`, `setEnabled`, `resolveWork`, `linkResource`, `approveDraft`. Không API thực thi method tuỳ ý. `OwnerUpdate = { updateId: number; messageId: number; chatId: string; senderId: string; replyToMessageId: number }`, chỉ nhận qua receiver credential, không từ runner.
- `ApprovalTicket` lưu receiverKeyId, action/payload đã chuẩn hoá, fingerprint, Page/workspace, chat/sender được phép, message đề nghị, `expiresAt`, trạng thái tiêu thụ và kết quả. TTL 15 phút là lựa chọn triển khai; hết hạn phải gửi đề nghị mới. Không đưa token xác nhận hoặc dữ liệu receiver vào runner response.
- Lỗi mới `FORBIDDEN`, `CONFLICT`, `LIMIT_EXCEEDED`, `NEEDS_REVIEW` qua `ControlError`; HTTP tương ứng 403/409/422/409. Lỗi không tiết lộ sự tồn tại của ID ngoài scope. Giữ nguyên envelope và lỗi cũ.

## Task 1: Bộ nhớ Page có nguồn và revision

**Files:** Create `src/models/pageOperations.ts`, `src/services/dailyBrief/PageBusinessStore.ts`, `src/__tests__/dailyBrief/PageBusinessStore.test.ts`. Modify `SYSTEM_DOCUMENTATION.md`.

**Interfaces:** Define các kiểu hồ sơ/fact/context ở hợp đồng chung. `PageBusinessStore(db: SqlDatabase)` xuất `ensureSchema(): void`, `get(pageId: string): PageBusiness | null`, `list(): PageBusiness[]`, `ensure(pageId: string, primaryProfileId: string | null, now: number): PageBusiness`, `propose(pageId: string, input: PageFactInput, expectedRevision: number, now: number): PageBusiness`. Các mutation tin cậy `confirmFact`, `setPrimaryProfile`, `setEnabled` nhận `expectedRevision` và metadata từ Task 6, không export qua runner methods. Fact IDs do server cấp; update fact đã confirmed bị từ chối, đề xuất thay thế dùng fact mới.

- [ ] **1. Viết test đỏ** bằng `memoryDb()` trong `src/__tests__/facebookPoster/helpers.ts`: `samePageSharesFactsAcrossProfiles` (`list().length === 1`); `confirmedFactCannotBeOverwritten`; `staleRevisionRejectsWithoutMutation`; `limitsRejectWithoutDeleting` (10/11 hồ sơ, 100/101 facts, 2000/2001, 1000/1001, 500/501 ký tự). `runnerCannotForgeConfirmation` phải giữ nguyên revision khi đưa `confirmed`, `owner`, `confirmedAt` hoặc `confirmationRef`.

Assertion mẫu cho các ca vừa nêu (arrange theo Interfaces):
```ts
expect(store.list()).toHaveLength(1);
expect(afterRejectedWrite).toEqual(beforeRejectedWrite);
```

- [ ] **2. Chạy đỏ:** `npm test -- --runInBand src/__tests__/dailyBrief/PageBusinessStore.test.ts`; phải fail vì store/hành vi chưa có, không phải lỗi môi trường.
- [ ] **3. Implement** bảng additive `page_business_profiles`, `page_business_facts`, unique Page trong DB workspace; compare-and-set revision và fact update cùng transaction. Xác nhận giữ nguyên source quan sát, thêm metadata xác nhận. Không auto-create cho person/unknown; evidence resolver của Task 7 chịu trách nhiệm kiểm nguồn trước gọi `propose`.
- [ ] **4. Chạy xanh** cùng lệnh + `src/__tests__/dailyBrief/DailyBriefStore.test.ts`; giữ nguyên brief schema/API cũ. Test lỗi DB bằng adapter ném lỗi: không báo thành công khi transaction không ghi được; production `query/queryOne` có thể trả rỗng khi lỗi, không dựa vào chúng sẽ luôn throw.
- [ ] **5. Review diff, cập nhật docs và commit khi được phép:** `feat(page-operations): add sourced page business memory`.

## Task 2: Công việc bền vững, lease và ngân sách agent

**Files:** Create `src/services/dailyBrief/PageWorkStore.ts`, `src/__tests__/dailyBrief/PageWorkStore.test.ts`. Modify `src/models/pageOperations.ts`, `src/services/dailyBrief/DailyBriefStore.ts`, `SYSTEM_DOCUMENTATION.md`.

**Interfaces:** `PageWorkStore(db: SqlDatabase)` xuất `ensureSchema(): void`, `get(id: string): PageWork | null`, `list(pageIds: string[]): PageWork[]`, `claimDue(context: PageContext, now: number): PageWork | null`, `beginStep(lease: WorkLease, stepKey: string, requestHash: string, now: number): WorkStep`, `finishStep(lease: WorkLease, stepKey: string, resource: PageResourceRef, now: number): void`, `transition(lease: WorkLease, next: PageWork['status'], patch: Partial<Pick<PageWork, 'waitFor' | 'nextCheckAt' | 'reason' | 'evidenceRefs' | 'lastError'>>, now: number): PageWork`, `prune(now: number): number`, `reconcileVideo(workId: string, videoId: string, status: 'running' | 'completed' | 'failed', now: number): PageWork`. Reconcile chỉ CAS việc đang waiting đúng video, không cần agent lease: running vẫn waiting, completed → pending, failed → needs_review; không tiêu attempt. Define `WorkLease`, `WorkStep`, `PageWork`, `PageResourceRef` ở model. Thêm `getResourceOwner(resource: PageResourceRef)` và `linkResource(workId: string, resource: PageResourceRef): void` cho service tin cậy.

- [ ] **1. Viết test đỏ:** `twoClaimsHaveOneWinner`; `staleCompletionCannotFinishNewLease` (cả clock cùng ms/lùi); `pollingDoesNotSpendAttempts` (`attempts` không đổi sau 100 poll); `fourthAgentInvocationIsRejected` (đúng ba lượt, dù bước khác); `waitingAcrossMidnightBlocksNewWork`; `needsReviewBlocksNextBrief`; `completedDraftDoesNotHoldLease`; `completedCarryoverDoesNotCreateAnotherDailyBrief`; `prunePreservesActiveWorkAndResources` (30 ngày).

Assertion mẫu cho các ca vừa nêu (arrange theo Interfaces):
```ts
expect(claims.filter(Boolean)).toHaveLength(1);
expect(after100Polls.attempts).toBe(before100Polls.attempts);
```

- [ ] **2. Chạy đỏ:** `npm test -- --runInBand src/__tests__/dailyBrief/PageWorkStore.test.ts`.
- [ ] **3. Implement** bảng additive `page_work_items`, `page_work_steps`, `page_work_resources`, `page_work_daily_usage` (attempts, draftsCreated, completed theo Page/ngày); unique `(page_id, brief_date)` và partial unique index cho một việc chưa kết thúc/Page. Claim và tăng attempt cùng transaction, chỉ tăng trước một lượt agent; poll không claim. Budget khoá bằng Page của brief chính và ngày local theo clock brief hiện có, không reset khi đổi step/primary profile. Công việc qua ngày giữ `briefDate`; ngân sách lượt tiếp tục tính ngày chạy thực tế, không tạo việc mới. `PageWork.attempts` là tổng lượt của work; daily usage mới quyết định giới hạn ngày. Claim tôn trọng giờ/enable/draftsPerDay của brief hiện có. Completion của work qua ngày đánh dấu ngày hoàn tất đã phục vụ; không chạy thêm một brief cùng ngày để vượt số nháp. Lưu nháp mới tăng daily draftsCreated trong transaction; retry/edit không tăng.
- [ ] **4. Chạy xanh** test mới + toàn bộ `src/__tests__/dailyBrief`. Thêm kiểm phối hợp: brief `enabled=false` không claim; legacy `claimDue` bỏ brief đang được chế độ mới quản lý nhưng không đổi semantics attempts của brief legacy. Bật lần đầu chỉ khi legacy brief idle, đặt `protectedSince`; legacy claim loại Page có dấu này. Disable không xoá dấu/chuyển về legacy. Prune work không cascade xoá ownership còn cần cho draft/video đang tồn tại. Retry sau TTL cache vẫn tìm draft từ `page_work_resources`.
- [ ] **5. Review diff/docs, commit khi được phép:** `feat(page-operations): persist work leases and step outcomes`.

## Task 3: Quyền scoped ở mọi biên Control API

**Files:** Create `src/services/control/controlAuthorization.ts`, `src/__tests__/control/controlAuthorization.test.ts`. Modify `src/models/pageOperations.ts`, `src/services/control/ControlStore.ts`, `ControlApiServer.ts`, `ControlMethods.ts`, `IdempotencyCache.ts` trong cùng thư mục; `src/services/database/DatabaseService.ts`; tests `src/__tests__/control/{ControlStore,ControlApiServer,ControlMethods,IdempotencyCache}.test.ts`; protocol và system docs.

**Interfaces:** Define `ControlPrincipal`, `PageAssignment` ở `src/models/pageOperations.ts`. `ControlStore.createKey(name: string, policy?: ScopedKeyPolicy)` vẫn trả `{id,name,key}`; `ScopedKeyPolicy` là nhánh scoped của principal bỏ `keyId`. `findActiveKeyByHash` trả thêm policy; không có policy là `legacy`. `authorizeMethod(principal, method, params, resources): void`, `authorizeRoute(principal, route, resource, resources): void`, `visibleMethods(principal, methods): ControlMethod[]`; `resources` cung cấp store ownership và `assertCurrent`. Extend context `run(params, {keyName, signal, principal, assertCurrent})`. `IdempotencyCache.run` thêm optional `requestHash` cuối signature, không đổi hành vi legacy.

- [ ] **1. Viết test đỏ:** `scopedRunnerRejectsEveryNonAllowlistedMethod` duyệt toàn registry; kiểm `drafts.approve` now/later, schedule/campaign mutations, CRM, render, config, cancel global và `confirm:true`. `authorizationRunsBeforeCachedResult`; `revokedKeyCannotReplay`; `sameIdempotencyKeyDifferentPayloadConflicts`; `hiddenMethodsAreAbsentFromDescribe`; `uploadDeniedBeforeReadingBody`; `videoDeniedBeforeOpenFile`.

Assertion mẫu cho các ca vừa nêu (arrange theo Interfaces):
```ts
expect(response.status).toBe(403);
expect(openVideoFile).not.toHaveBeenCalled();
```

- [ ] **2. Chạy đỏ:** `npm test -- --runInBand src/__tests__/control`.
- [ ] **3. Implement** policy JSON validated, immutable, hash-only secret, migration additive bằng conventions `CONTROL_MIGRATIONS`. Kiểm quyền sau xác thực/resolve method nhưng trước `idempotency.run`. Scoped request hash bao gồm canonical params và policy; cache record thiếu fingerprint không được dùng như scoped record. Revalidate quyền trước replay và trước side effect, không dùng tên khoá.
- [ ] **4. Chạy xanh** toàn control suite. Policy khởi đầu: runner chỉ có `system.capabilities` mới, `profiles.list`/`pages.list` được lọc, `pages.learn` bắt buộc explicit profileIds thuộc assignments, không force và không mặc định toàn workspace và các method `pageBusiness`/`pageWork` ở Task 7. Từ chối API legacy broad kể cả `events.wait`, history/aggregates và research mặc định mọi profile; không cố lọc những response chưa chứng minh an toàn. `/v1/media` runner bị từ chối trong A; `/v1/videos/file` chỉ tài nguyên đã liên kết và đúng scope. `/health`/`bridge.py` vẫn giữ IP/lockout rules, không chứa dữ liệu Page.
- [ ] **5. Review diff/docs, commit khi được phép:** `feat(control): enforce scoped page runner authorization`.

## Task 4: Cấp khoá có phạm vi mà không phá pairing cũ

**Files:** Create `src/ui/components/settings/ControlKeyScope.tsx`. Modify `src/services/control/PairingTickets.ts`, `src/services/control/controlConfig.ts`, `electron/ipc/controlApiIpc.ts`, `electron/preload.ts`, `src/ui/lib/ipc.ts`, `src/ui/components/settings/ControlApiSettings.tsx`, `src/ui/components/settings/PairingPanel.tsx`; tests `src/__tests__/control/PairingTickets.test.ts`, `ControlApiServer.test.ts`, `controlWiring.test.ts`, `src/__tests__/control/controlConfig.test.ts`; system/protocol docs.

**Interfaces:** IPC `createKey(name: string, policy?: ScopedKeyPolicy)`; `createPairing({name,botIp,publicHost,policy?})`. Ticket giữ policy máy chủ đã xác minh; `/pair` body không được thay policy. `ControlKeyScope` dùng props `{ value: ScopedKeyPolicy | null; onChange(value): void; identities: PageIdentity[]; workspaceId: string }`; `null` là legacy rõ nhãn, không đổi callers cũ. Thêm `ControlConfig.protectedWritesEnabled: boolean` mặc định false qua local `setConfig`/Settings; payload legacy bỏ field giữ giá trị đang lưu, không reset. Checkbox bật có cảnh báo và yêu cầu operator xác nhận đã kiểm receiver isolation; đây là khai báo vận hành, không bằng chứng kỹ thuật tự động.

- [ ] **1. Viết test đỏ:** `pairBodyCannotUpgradeRunnerRole`; `ticketPreservesWorkspaceAndAssignments`; `invalidOrPersonAssignmentIsRejected`; `legacyPairingStillWorks`; `employeeCannotProvisionKeys`. Backend kiểm mọi Page/profile có identity phù hợp, không chỉ tin checkbox UI.

Assertion mẫu cho các ca vừa nêu (arrange theo Interfaces):
```ts
expect(pairedKey.policy).toEqual(ticket.policy);
expect(legacyKey.policy).toBeNull();
```

- [ ] **2. Chạy đỏ:** `npm test -- --runInBand src/__tests__/control/PairingTickets.test.ts src/__tests__/control/ControlApiServer.test.ts src/__tests__/control/controlWiring.test.ts`.
- [ ] **3. Implement** selector mục đích “Runner chuẩn bị nháp”/“Receiver xác nhận”/“Legacy toàn quyền”, chọn Page/profile đã học, hiển thị scope trong danh sách khoá; receiver thêm owner chat/sender đã được operator xác nhận (không yêu cầu JSON). Tái dùng Card, input/select, notification và modal hiện có; raw key chỉ hiển thị lúc tạo, không thêm dashboard. Receiver key không được chung export/env với runner key; UI nhắc yêu cầu cách ly, không tuyên bố chỉ tạo hai khoá là đủ.
- [ ] **4. Chạy xanh** tests trên + renderer typecheck. Browser kiểm ở 1440×900 và 390×844, light/dark: lựa chọn/trống/lỗi/tạo/thu hồi/copy/key dài; bàn phím/focus; `scrollWidth <= clientWidth`; không chồng text. Chỉ mock IPC/data, không cấp key production hoặc đổi cấu hình thật.
- [ ] **5. Review diff/docs, commit khi được phép:** `feat(control): provision scoped runner and receiver keys`.

## Task 5: Side effect có chủ sở hữu và khôi phục research/draft/video

**Files:** Create `src/services/dailyBrief/pageWorkOperations.ts`, `src/__tests__/dailyBrief/pageWorkOperations.test.ts`. Modify `src/models/pageOperations.ts`, `src/models/facebookPoster.ts`, `src/services/research/ResearchService.ts`, `electron/ipc/researchIpc.ts`, `electron/ipc/facebookPosterIpc.ts`, `src/services/facebookPoster/drafts.ts`, `src/services/facebookPoster/FacebookPosterStore.ts`, `src/services/control/InboxMediaStore.ts`, `electron/ipc/inboxMedia.ts`, `src/services/video/videoOperations.ts`, `electron/ipc/videoIpc.ts`; tests research/drafts/media/video hiện có và system docs.

**Interfaces:** `createPageWorkOperations(deps)` trả `research(lease: WorkLease, input: PageResearchInput): Promise<{scanId: string}>`, `saveDraft(lease: WorkLease, draftIndex: number, input: PageDraftInput): Promise<{draftId: string; revision: number}>`, `getDraft(workId: string, draftId: string): PageDraftView`, `reconcile(workId: string): Promise<PageWork>`, `cancelOwned(workId: string): Promise<void>`. `deps` gồm hai store, `context(workId): PageContext`, `assertCurrent`, clock và existing research/poster/video/media operations; browser slot lấy từ FacebookPosterService, không tạo semaphore thứ hai. Thêm `attachVideo(workId, videoId)` chỉ cho trusted owner flow, không cho runner tự nhận một video ID bất kỳ.

- [ ] **1. Viết test đỏ:** `researchUsesSharedBrowserSlot`; `dueScheduleWinsBeforeResearchStarts`; `changedActorStopsBeforeBrowserAction`; `foreignNestedIdsRejectWithoutSaving`; `savedDraftSurvivesLostResponseAndCacheExpiry`; `finishedVideoReacquiresExpiredMediaWithoutRendering`; `unknownSideEffectStopsForReview`; `cancelDoesNotCancelIndependentApprovedSchedule`.

Assertion mẫu cho các ca vừa nêu (arrange theo Interfaces):
```ts
expect(savedDraftIds).toHaveLength(1);
expect(startRender).not.toHaveBeenCalled();
```

- [ ] **2. Chạy đỏ:** `npm test -- --runInBand src/__tests__/dailyBrief/pageWorkOperations.test.ts`.
- [ ] **3. Implement shared browser ownership:** inject acquire/release/shouldYield từ poster vào research; acquire trước tạo scan/mở browser, release trong finally, yield tại điểm an toàn khi lịch đã đến giờ. Reuse `readPageIdentity` trước thao tác được bảo vệ, không tin identity cũ còn lưu sau learn lỗi. Kiểm Page/context lại trước lưu nháp. Chờ video không giữ browser slot; person/checkpoint/login/sai actor → chặn, không đổi Page tự động.
- [ ] **4. Implement durable effects:** reserve stable step trước effect; research scan/draft ID được server định trước và lưu/liên kết cùng DB transaction khi có thể. Không bọc file copy/await trong transaction SQLite; lỗi giữa chừng đối soát ID trước, chưa rõ thì review. Draft chỉ own-Page target, không group posting trong A; map whitelist PageDraftInput sang SaveDraftInput hiện có, reject unknown params/paths và kiểm ownership campaign/media/cấu hình nháp đang sửa. Thêm draft revision monotonic ở model/store và optional expectedRevision cho SaveDraftInput; scoped edits bắt buộc CAS, legacy save giữ contract cũ. `draftIndex` phải trong `[0, draftsPerDay)`, create step key `draft:<index>`, edit step key `draft:<index>:revision:<expectedRevision+1>`; requestHash khác trên cùng key bị từ chối. Retry trả cùng ID/revision, edit không chiếm thêm slot nháp/ngày. Không thay validation cũ.
- [ ] **5. Implement video/media recovery:** video từ luồng khách đã yêu cầu phải được trusted flow gắn đúng work; polling dùng video library record của đúng workspace. Adopt lại file qua open-file stream an toàn (`O_NOFOLLOW`, fstat), không nhận arbitrary path; lưu ownership của media mới trong workspace/work resource links vì inbox hiện là application-global. Nếu video/library mất thì review, không render lại. AHV không có huỷ remote: chỉ báo dừng theo dõi cục bộ.
- [ ] **6. Chạy xanh** test mới + `npm test -- --runInBand src/__tests__/research src/__tests__/facebookPoster src/__tests__/video src/__tests__/control/ControlApiServer.test.ts`. Simulate crash trước/sau reserve, resource write và link; restart DB tạm rồi assert chỉ một draft, không gọi render; stale callback sau workspace switch không ghi DB mới.
- [ ] **7. Review diff/docs, commit khi được phép:** `feat(page-operations): recover owned preparation effects`.

## Task 6: Xác nhận gắn phiên bản, không nhận lời khai của runner

**Files:** Create `src/services/dailyBrief/pageApprovalOperations.ts`, `src/__tests__/dailyBrief/pageApprovalOperations.test.ts`. Modify `src/models/pageOperations.ts`, `src/services/dailyBrief/PageWorkStore.ts`, `src/models/facebookPoster.ts`, `src/services/facebookPoster/FacebookPosterStore.ts`, `src/services/facebookPoster/drafts.ts`, `src/services/facebookPoster/scheduleUpdate.ts`; tests drafts/scheduleUpdate và system/protocol docs.

**Interfaces:** Define `OwnerAction`, `OwnerUpdate`, `ApprovalTicket`. `createPageApprovalOperations(deps)` xuất `prepare(action: OwnerAction, receiver: ControlPrincipal): ApprovalTicket`, `bindMessage(ticketId: string, chatId: string, senderId: string, messageId: number): void`, `confirm(ticketId: string, update: OwnerUpdate, receiver: ControlPrincipal): Promise<{resourceId: string; replayed: boolean}>`. `deps` dùng existing draft/business/work stores, clock, `assertCurrent`, cấu hình receiver chat/sender đã được owner thiết lập (không từ runner). Dùng draft revision của Task 5, bổ sung `expectedRevision?: number` vào `ApproveDraftInput`; desktop/legacy không truyền vẫn giữ hành vi.

- [ ] **1. Viết test đỏ:** `runnerCannotPrepareOrConfirmOwnerAction`; `changedDraftInvalidatesApproval` (text/file/target/timing); `wrongChatSenderReplyOrExpiredTicketRejects`; `replayedUpdateHasOneResult`; `ambiguousOkHasNoTicket`; `confirmationPreservesObservationSource`; `legacyAndDesktopApprovalStillWork`.

Assertion mẫu cho các ca vừa nêu (arrange theo Interfaces):
```ts
await expect(operations.confirm(ticket.id, wrongSenderUpdate, receiver)).rejects.toMatchObject({ code: 'FORBIDDEN' });
expect(approveDraft).not.toHaveBeenCalled();
```

- [ ] **2. Chạy đỏ:** `npm test -- --runInBand src/__tests__/dailyBrief/pageApprovalOperations.test.ts src/__tests__/facebookPoster/drafts.test.ts`.
- [ ] **3. Implement** bảng additive `page_owner_approvals` trong PageWorkStore, dùng fingerprint canonical payload + revision, TTL 15 phút; consume ticket/update và promote draft atomic cùng DB; scheduler wake/event delivery sau commit, không gọi async/network trong transaction. Draft revision tăng ở mọi mutation có thể đổi nội dung/tệp/đích/lịch, không dùng `updatedAt` làm revision. Recheck complete destination/timing snapshot trước promotion. Giữ draft disabled/`nextRunAt:null` trước duyệt.
- [ ] **4. Implement owner actions** bằng existing operations, union đóng không generic method call. `setPrimaryProfile` chỉ chọn learned Page phù hợp và không chuyển việc đang chạy; đổi/disable phải invalidate lease ở điểm an toàn. `resolveWork` chỉ đối soát/tiếp tục khi bằng chứng rõ hoặc huỷ; không khởi chạy lại effect mơ hồ. Fact mới từ chủ Page được tạo/xác nhận với reference thông điệp receiver; không cho runner giả `sourceType: owner`.
- [ ] **5. Chạy xanh** tests trên + scheduleUpdate suite; assert timing “now” vẫn kiểm confirm/validation hiện có, approval cùng update không đăng hai lần; sai revision không thay DB. Ticket content không xuất qua runner describe/get/cache/events.
- [ ] **6. Review diff/docs, commit khi được phép:** `feat(page-operations): bind owner approval to exact revisions`.

## Task 7: Method công khai, provenance và lifecycle workspace

**Files:** Create `src/services/control/pageOperationMethods.ts`, `src/__tests__/control/pageOperationMethods.test.ts`. Modify `electron/ipc/dailyBriefIpc.ts`, `electron/ipc/controlApiIpc.ts`, `electron/ipc/workspaceIpc.ts`, `src/services/control/ControlMethods.ts`, `src/services/control/controlEvents.ts`, `src/services/dailyBrief/PageWorkStore.ts`; `src/__tests__/control/controlWiring.test.ts`; system/protocol docs.

**Interfaces:** `createPageOperationMethods(deps): ControlMethod[]` ghép vào registry hiện có; `getPageBusinessStore()`, `getPageWorkStore()` theo cache schema-per-db-path của `getDailyBriefStore`. `system.capabilities` trả `{pageOperations: 1, principal: {kind,workspaceId,assignments}, protectedWritesEnabled: boolean}`; không secret/approval data. Factories operations nhận deps bound theo từng request/principal, không giữ “current key” trong biến global chia sẻ giữa requests. Các method ở bảng dưới là toàn bộ API mới, params/return dùng kiểu ở task trước; ID/page ngoài phạm vi trả lỗi không tiết lộ.

| Method | Params → result | Quyền |
|---|---|---|
| `pageBusiness.get` | `{pageId}` → `{business, evidenceAvailability}` | Runner/receiver đúng Page |
| `pageBusiness.propose` | `{workId,claimedAt,expectedRevision,fact}` → `{business}` | Runner, active lease, nguồn được kiểm |
| `pageWork.list` / `pageWork.get` | `{}` / `{workId}` → `{items}` / `{work}` | Tự lọc assignments, không nhận “all” |
| `pageWork.claimDue` | `{pageId}` → `{work: PageWork \| null}` | Runner, primary brief, enabled và deployment gate |
| `pageWork.research` | `{workId,claimedAt,input: PageResearchInput}` → `{scanId}` | Runner, scoped source/profile |
| `pageWork.researchResult` | `{workId,scanId}` → `{scan,items}` | Chỉ linked scan, lọc profile/items/counts |
| `pageWork.saveDraft` | `{workId,claimedAt,draftIndex,draft: PageDraftInput}` → `{draftId,revision}` | Runner, linked own-Page draft |
| `pageWork.draft` | `{workId,draftId}` → `{draft: PageDraftView}` | Linked draft, không lộ filesystem path |
| `pageWork.waitVideo` | `{workId,claimedAt,videoId}` → `{work}` | Chỉ video đã trusted-link |
| `pageWork.reconcile` | `{workId}` → `{work}` | Poll không gọi agent/tăng attempts |
| `pageWork.finish` | `{workId,claimedAt,reason,evidenceRefs}` → `{work}` | Completed chỉ khi đủ linked drafts bền vững |
| `pageWork.fail` | `{workId,claimedAt,code,reason}` → `{work}` | Server phân retryable/failed/review, không AI tự vượt budget |
| `pageApprovals.prepare` / `bindMessage` / `confirm` | Theo Task 6 → ticket/binding/result | Chỉ receiver, không legacy AI/runner |
| `pageWork.events` | `{after,timeoutSec}` → `{events,nextCursor,workspaceId}` | Receiver, chỉ thông báo công việc assigned |

- [ ] **1. Viết test đỏ:** `unownedResearchCannotBecomeEvidence`; `arbitraryUrlIsNotReadEvidence`; `deletedEvidenceIsReportedUnavailable`; `secondaryBriefDoesNotClaim`; `workspaceSwitchInvalidatesOldCallbacks`; `eventsAdvancePastHiddenRows`; `historyCountsDoNotLeakOtherPages`; `protectedWritesFailClosed`.

Assertion mẫu cho các ca vừa nêu (arrange theo Interfaces):
```ts
expect(response.nextCursor).toBeGreaterThan(request.after);
expect(response.events.every(event => allowedWorkIds.has(event.workId))).toBe(true);
```

- [ ] **2. Chạy đỏ:** `npm test -- --runInBand src/__tests__/control/pageOperationMethods.test.ts src/__tests__/control/controlWiring.test.ts`.
- [ ] **3. Implement evidence resolution** từ identity snapshot/learn timestamp hoặc research scan/item thực sự thuộc work/assignment. URL phải khớp bản ghi đã đọc; không fetch URL theo params. Provenance lưu reference và thời gian, không raw HTML; nguồn bị xoá vẫn giữ fact nhưng response báo không còn nguồn. Mâu thuẫn confirmed fact giữ nguyên và trả đề xuất cần review. Không tạo trường/số doanh thu mặc định.
- [ ] **4. Implement wiring/lifecycle:** capture workspace ID + DB path của runtime; kiểm `isWorkspaceSwitchInProgress()` trước/ sau await. Stop new claims, cancel/wait only owned browser jobs trước DB swap; invalidate leases, giữ lịch độc lập. Khởi động lại phục hồi waiting/review trước new work. `protectedWritesEnabled` là trạng thái do operator tin cậy bật sau Task 9, mặc định false, runner không sửa được. Khi false, chặn mọi runner mutation/side effect kể cả media adoption trong reconcile; status reads vẫn được, không fallback legacy. `pages.learn` scoped cũng phải qua gate và kiểm shared slot/identity theo Task 5.
- [ ] **5. Implement notifications** dùng event store hiện có: chỉ safe `pageWork.*` payload đã chiếu theo work ownership, không phát raw resource/secret. `nextCursor` luôn tiến qua hàng bị ẩn; paginate bounded 100 hàng/lượt, tiếp tục trang sau thay vì kết luận “không còn event”. Emit một event cho một transition/revision trong transaction với state. Hết retention: receiver reconcile work/draft IDs, không tái tạo nghiệp vụ từ event.
- [ ] **6. Chạy xanh** focused tests + toàn bộ control/dailyBrief; kiểm mọi method mới có metadata/validation/docs-check. Test employee/workspace guards, duplicate/stale/out-of-order events và key thu hồi giữa hai bước; legacy clients vẫn đọc old envelopes.
- [ ] **7. Review diff/docs, commit khi được phép:** `feat(control): expose scoped page preparation lifecycle`.

## Task 8: Runner tiếp tục công việc và adapter Telegram tách quyền

**Files:** Modify `tools/maihub-bridge/maihub_bridge.py`, `tools/maihub-bridge/tests/test_bridge.py`, `tools/maihub-bridge/README.md`, `SYSTEM_DOCUMENTATION.md`, `docs/protocol/maihub-control-protocol.md`.

**Interfaces:** Thêm `--protected` cho `brief-tick` và `install-brief`, giữ default legacy để không âm thầm đổi client. `protected_brief_tick(client, run_agent_fn, clock, state_path)` dùng PageWork API; `handle_owner_update(client, update, pending)` là adapter gọi từ receiver đã xác thực transport, không endpoint công khai nhận JSON tự khai. Protected watcher dùng `pageWork.events` và state atomic hiện có; runner không instantiate TelegramSender. Cấu hình receiver trong file riêng, user khác; runner env chỉ có scoped key, không Telegram token/owner key.

- [ ] **1. Viết test đỏ:** `test_protected_tick_rejects_legacy_key`; `test_no_work_calls_no_agent`; `test_waiting_video_only_polls`; `test_resume_after_media_expiry_does_not_render`; `test_three_invocations_across_steps`; `test_prompt_separates_evidence_hypothesis_and_unknown`; `test_owner_reply_must_match_pending_revision`; `test_install_rejects_shared_secret_access`; `test_send_timeout_is_not_blindly_retried`.

Assertion mẫu cho các ca vừa nêu (arrange theo Interfaces):
```python
self.assertEqual(agent.call_count, 0)  # waiting video
self.assertEqual(render.call_count, 0)  # existing video ID
```

- [ ] **2. Chạy đỏ:** `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tools/maihub-bridge/tests -p 'test_*.py'`.
- [ ] **3. Implement protected tick:** capability/role check trước work; giữ flock, timer 15 phút, budget 3300 s và headroom 180 s hiện có. Reconcile việc cũ trước claim; hết pending không gọi AI. Claim sát lúc invoke; process group timeout dùng cơ chế hiện có, không weaken sandbox. Prompt chỉ mô tả tool được scoped server cho phép, không chỉ dựa vào `--allowedTools`; nêu rõ không doanh thu/không tự render/không tự duyệt.
- [ ] **4. Implement handoff:** tách subprocess env/home/MCP config khỏi receiver secrets; same UID hoặc runner đọc/ghi được receiver path → từ chối protected write installation. Candidate dry-run dưới đúng OS user trước khi ghi systemd units; không sudo cho agent. Migration legacy→protected kiểm không có hai timer quản lý cùng brief; không tự xoá/bật lại legacy. Tests chỉ render units/mock filesystem/command, không cài service thật.
- [ ] **5. Implement owner adapter/notifications:** parser NL chỉ đề xuất intent; receiver gửi bản tóm tắt cụ thể, gọi prepare/bindMessage, chỉ confirm khi message thực từ đúng chat/sender reply đúng đề nghị còn hạn. “ok” không gắn đề nghị thì hỏi lại. Dùng durable delivery state keyed workspace/work/draft/revision, atomic replace; send timeout không biết đã nhận thì đánh dấu uncertain và không tự resend vô hạn. Callback edit/discard giữ luồng hiện có, không giữ work lease chờ khách.
- [ ] **6. Chạy xanh** toàn bộ Python suite hai lần, mock long video qua ngày, missed events, kill/restart trước/sau save, HTTP 403/revocation, unavailable capability, disk-full state save. Khôi phục từ work IDs khi watcher state/event hết hạn; không báo exactly-once Telegram hoặc đã huỷ AHV remote. Unit tests của prompt không chứng minh AI thật luôn tuân thủ; ghi rõ giới hạn này.
- [ ] **7. Review diff/docs, commit khi được phép:** `feat(bridge): resume protected page work and owner handoff`.

## Task 9: Hai vòng stress, hồi quy và cổng pilot

**Files:** Create `src/__tests__/dailyBrief/pageOperations.integration.test.ts`. Modify tests scoped hiện có nếu cần ca tích hợp, `SYSTEM_DOCUMENTATION.md`, `docs/protocol/maihub-control-protocol.md`, `tools/maihub-bridge/README.md`, `README.md`, spec §trạng thái/ghi chú sau triển khai. Không đổi version khi chỉ chuẩn bị local.

**Interfaces:** Dùng actual stores/registry/HTTP server với in-memory hoặc temporary DB, fake clock/browser/video/Telegram; không mock bỏ qua authorization/transactions đang được chứng minh. Tái dùng fixture/helpers hiện có, dữ liệu giả không mang session thật.

- [ ] **1. Viết integration test đỏ:** `threePagesRemainIsolatedThroughDraftCompletion`; `duplicateProfilesShareMemoryButRunOneBrief`; `videoOutlivesAgentAndResumesOnce`; `runnerCannotApproveViaAnyRoute`; `trustedApprovalRequiresCurrentRevision`; `restartAndRevocationStopStaleWrites`. Assert số side effect, DB rows và browser-slot ownership, không chỉ assert status code.

Assertion mẫu cho các ca vừa nêu (arrange theo Interfaces):
```ts
expect(new Set(drafts.map(draft => draft.id)).size).toBe(drafts.length);
expect(renderCallsAfterRecovery).toBe(0);
```

- [ ] **2. Chạy đỏ**, rồi chỉ sửa wiring/code trong phạm vi cho đến xanh: `npm test -- --runInBand src/__tests__/dailyBrief/pageOperations.integration.test.ts`. Không sửa/xoá test fail để đạt xanh.
- [ ] **3. Vòng stress 1 — hành vi:** ba Page, hai profile một Page, limit boundaries, nguồn thiếu/đã xoá, nháp/video hiện có và legacy clients. Full Jest/Python + typecheck/build/docs-check dưới đây. UI cả hai viewport/light-dark; check cấp khoá legacy/scoped, pairing và thu hồi với fake IPC. Ghi output/log trong scratchpad, không đưa artefact thử nghiệm vào repo.
- [ ] **4. Vòng stress 2 — lỗi/cạnh tranh:** hai claims đồng thời, late completion, clock lùi, revocation sau await, switch DB, lease timeout, event trùng/mất, idempotency >24 h, media hết hạn, render >160 phút giả lập, draft/Telegram timeout, restart và disk full. Lặp full Jest/Python; UI desktop/mobile/light-dark với lỗi mạng, nhãn dài, loading và keyboard/focus. Không chạy thời gian thực 160 phút: fake clock.
- [ ] **5. Review actual diff và ghi ma trận hồi quy:** daily suggestions/identity learning, research, nháp + approve/schedules, first comment, comment collector/leads, HyperFrames/AHV, bridge/watch/pairing/install dry-run, employee/workspace guards. Mỗi dòng có test/command và kết quả; không viết “không ảnh hưởng” thay bằng chứng.
- [ ] **6. Cổng receiver/pilot:** xác định entrypoint của receiver VPS thật và nối `handle_owner_update` tại sự kiện transport đã xác thực; kiểm user/file/env/MCP separation trên môi trường được anh cho phép. Repo có Telegram ingress cho app, không được coi là receiver VPS này. Chưa có quyền truy cập hoặc chưa chứng minh cách ly → đánh dấu **integration blocked; proposal/read-only**, `protectedWritesEnabled=false`; không tuyên bố đợt A end-to-end xong. Không tạo poller Telegram thứ hai tranh `getUpdates` hoặc yêu cầu đưa owner token vào runner để vượt chặn.
- [ ] **7. Chốt tài liệu/commit khi được phép:** `test(page-operations): verify recovery isolation and compatibility`. Trạng thái spec chỉ “đã triển khai và kiểm thử local” nếu đúng; liệt kê live pilot/receiver chưa kiểm. Chỉ sau approval triển khai riêng: dev → tests/review → build artifact/image → deploy artifact, không copy source vào prod.

### Lệnh nghiệm thu

```bash
# Các target bắt buộc theo quy định: báo thật nếu repo vẫn chưa cung cấp.
make build
make test
make lint

# Các lệnh repo thực sự có; chạy cả hai vòng, không gọi typecheck là lint.
npm test -- --runInBand
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tools/maihub-bridge/tests -p 'test_*.py'
./node_modules/.bin/tsc --noEmit -p tsconfig.json
./node_modules/.bin/tsc -p tsconfig.electron.prod.json
node scripts/strip-console.js
npm run build:renderer
node scripts/check-docs.js
git diff --check
```

Repo khảo sát không có Makefile targets/lint script; không thêm hạ tầng ngoài scope. Lệnh trên build phần TypeScript/renderer, **không** tạo bộ cài production hoàn chỉnh. `npm run production` còn E2EE bridge, native rebuild và electron-builder; chỉ chạy đóng gói sau khi kiểm điều kiện build và có phép phù hợp, không báo đã có release artifact từ riêng Vite build. Giữ và báo warning baseline, không tắt validation để làm output sạch.

## Thứ tự, rollback và bàn giao

- Dependencies: 1 → 2 → 3; 4 sau 3; 5 sau 1/2/3; 6 sau 1/2/5; 7 sau 3/5/6; 8 sau 7; 9 cuối. Nghiên cứu/read-only và các nhóm test độc lập có thể song song; không cho hai implementer sửa chung model/IPC/docs. Dùng worker theo task và review tại từng cổng nếu giữ cách thực hiện đã chọn trước đó.
- Rollback code theo commit riêng được owner chấp thuận, không reset/revert thay đổi của anh. Rollback vận hành dừng claims/owned work, thu hồi scoped runner key, giữ hồ sơ/audit và lịch đã duyệt. Không tự bật legacy, không xoá schema/data để rollback.
- Trước mỗi commit được phép: fresh verification + actual diff review; dùng attribution `Co-Authored-By: Claude Code <noreply@anthropic.com>`. Không push/tag/deploy trong kế hoạch này.
- Self-review: spec §§1–4/9–10 → Constraints, Tasks 1/8/9; §6 → 1/2/5/7; §7 → 3/4/6/8/9; §8 → 2/5/7/8; §11 → File structure; §§12–13 → 9 và rollback. Năm Review Focus đều có test cụ thể. Các interfaces dùng chung được định nghĩa trước consumer; legacy ownership/media-global và receiver chưa xác minh được nêu như ràng buộc, không bị coi là chức năng đã có.
- Kế hoạch đã được anh duyệt ngày 27/10/2026. Approval này cho phép triển khai local; không cấp quyền thao tác dịch vụ thật, commit/push hoặc production ngoài các phép riêng đã có.
