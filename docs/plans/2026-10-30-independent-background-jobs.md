# Independent Background Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đang đăng Facebook vẫn soạn/lưu nháp và làm việc khác, cho các job không tranh profile tiến triển đồng thời, hủy và theo dõi đúng từng lượt.

**Architecture:** Tái sử dụng `FacebookPosterService` như worker một lượt; coordinator theo workspace quản lý tối đa hai worker. Một queue tài nguyên theo profile dùng reservation của `BrowserProfileService`, bao phủ cả side services; API/UI mở rộng theo runId và lifecycle drain tất cả chủ sở hữu trước đóng DB.

**Tech Stack:** TypeScript/Electron, React 18, SQLite/better-sqlite3, Jest, Playwright hiện có và Python bridge stdlib. Không dependency mới, không server/Redis/thread pool hoặc schema queue bền vững.

**Spec:** `docs/specs/2026-10-30-independent-background-jobs.md` — anh duyệt bản viết ngày 30/10/2026 bằng “a duyệt nhé”.

**Trạng thái:** Anh đã duyệt kế hoạch và yêu cầu thực hiện bằng subagent ngày 2026-10-30. Tasks 1–8 đã triển khai trong dev (2026-10-31), chờ broad review cuối; full Jest randomized xanh sau hai vòng sửa (fix-1/fix-2), release BLOCKED; chưa nghiệm thu hoặc phát hành. Baseline là working tree trên `feat/26.31-daily-post-suggestions`, gồm các thay đổi chưa commit hiện có; không khởi tạo từ HEAD làm mất chúng.

## Global Constraints

- Tối đa **2 lượt sống** trong nhóm `post`, `scan_groups`, `join`, `collect_comments`, tính cả chờ profile; từ chối lượt thứ ba trước tạo run/effect. Mỗi side service giữ giới hạn **1 job** riêng.
- **30** browser profiles tổng, gồm manual, pending open và automation; reservation không tạo thêm capacity. Mỗi profile một chủ, owner token chỉ nội bộ, gắn workspace/generation/job ID.
- Chờ profile tối đa **7.200.000 ms**; lịch giữ grace **60.000 ms**, queue wait **7.200.000 ms** và deadline occurrence gốc. Không poll dày, không reset timeout qua retry, không preempt session.
- Giữ concurrency/stagger/delay, validation/media limits, recurring/once, quota Page, authority/identity barrier, journal/recovery và uncertain-after-submit. Không nhân quota theo worker/profile hoặc dùng quyền owner legacy cho runner.
- `protectedWritesEnabled=false` trên cấu hình thật. Không gọi Facebook/Claude/Telegram/video thật, không migration khách, không đổi Downloads, sandbox, version/dependencies; không stage/commit/push/deploy khi chưa có phép riêng.
- Không giữ transaction SQLite qua await. Callback/result/cleanup của job dùng DB/store/workspace đã capture, không đi theo singleton mới; release cũ không nhả owner mới.
- Không lưu/log cookie, token hoặc HTML thô trong code/test/facts/audit/bot. Identifiers tiếng Anh, copy UI tiếng Việt; dùng tokens `DESIGN.md`, không làm lại visual identity.
- Cache UI tối đa **500 log/lượt**, tối đa hai lượt sống và một lượt đang xem; không vô hạn theo lịch sử. Mỗi vòng stress có desktop/mobile × light/dark.
- Doanh thu/ROI đã loại scope; không xóa legacy unavailable fields. Không gộp autonomous operating loop mới, comment executor độc lập hoặc publish-proof/metrics vào kế hoạch này.
- Mỗi task dùng TDD, review diff thực tế và cập nhật `SYSTEM_DOCUMENTATION.md` cùng thay đổi contract/giới hạn; protocol/README/DESIGN/docs-check cập nhật tại task sở hữu. Không xóa/bỏ qua assertion để che regression. Các assertion “khóa toàn ứng dụng” được thay bằng assertion mới theo spec đã duyệt, đồng thời giữ giới hạn một job của từng side service.
- Không thêm Make/lint infrastructure ngoài phạm vi để đổi blocker thành pass. `RULES.md`, `WORKFLOW.md` và `~/.codex/rules/core/file-creation.md` không tồn tại ở thời điểm lập plan; ghi ngoại lệ thiếu tài liệu, không tạo bản thay thế. Trước tạo file ở đợt triển khai kiểm lại checklist nếu đã được bổ sung.

## Review Focus

1. **Browser close timeout / late launch / closeAll:** promise close hết hạn không chứng minh browser đã chết; không cấp profile hoặc đóng DB sớm — Tasks 1, 5, 8.
2. **Reentry và completion ngay trong start:** worker/side job phải chiếm admission trước callback; failed start không rò capacity, finished callback không xóa worker mới — Tasks 2, 3, 8.
3. **Research pinned profile bận:** không đổi sang Page khác hoặc kết luận no_profile_available chỉ do contention; vẫn giữ exclusion/login/daily cap — Tasks 3, 8.
4. **Cancel dialog và active bootstrap xen event:** ID chọn trước await phải giữ nguyên; snapshot muộn không hồi sinh run finished hay ghi đè composer — Tasks 6, 7, 8.
5. **A→B→A cùng DB path và nhiều managed runs:** generation cũ không có quyền lại; revocation/drain phải bao phủ mọi execution, settlement vẫn vào captured DB — Tasks 2, 3, 5, 8.

---

## File structure và quyết định tích hợp

| Trách nhiệm | File mới | File hiện có cần sửa |
|---|---|---|
| Quyền profile và hàng chờ | `src/services/browser/ProfileJobQueue.ts` | `src/services/browser/BrowserProfileService.ts`, `electron/ipc/browserProfileIpc.ts` |
| Nhiều lượt poster | `src/services/facebookPoster/FacebookPosterCoordinator.ts` | `FacebookPosterService.ts`, `electron/ipc/facebookPosterIpc.ts` |
| Side jobs độc lập | Không thêm service tương đương | `loginCheck.ts`, `PostTracker.ts`, `CommentCollector.ts`, `src/services/dailyBrief/PageLearner.ts`, `src/services/research/ResearchService.ts`, `electron/ipc/researchIpc.ts` |
| Lịch theo tài nguyên | Không thêm scheduler | `FacebookPosterScheduler.ts`, composition và các side schedulers nếu cần theo callbacks hiện có |
| Quit/drain | `src/services/app/quitGuard.ts` | `electron/main.ts`, `electron/ipc/workspaceIpc.ts`, `updateIpc.ts`, `facebookPosterIpc.ts`, `browserProfileIpc.ts` |
| API và bridge | Không thêm protocol/adapter thứ hai | `ControlMethods.ts`, `electron/preload.ts`, `src/ui/lib/ipc.ts`, `tools/maihub-bridge/maihub_bridge.py` |
| State UI | `src/ui/features/facebookPoster/runState.ts` | `FacebookPosterView.tsx`, `PostTab.tsx`, `RunPanel.tsx`, `JoinTab.tsx`, `CommentsTab.tsx` trong cùng thư mục |

Ngoài các file mới trên, thêm test đúng module tại từng task; không tách lớp/factory chung không có người dùng. `pruneDiagnostics` đã nhận `keep: ReadonlySet<string>` nên chỉ sửa caller. Queue/coordinator không initialize/migrate/recover DB; recovery/prune giữ lifecycle workspace một lần.

Ba chi tiết contract được làm rõ, không đổi shape legacy: `current` rỗng thực tế là `{run:null,progress:null}`; operation/IPC active dùng `{runs:RunSnapshot[]}` vì wrapper spread object; **HTTP `runs.active` trả array snapshot trong `result`**, rỗng là `[]`. Quit hiện khác workspace: before-quit không await và renderer quit có force-exit sau 5 giây; cả hai thuộc Task 5, không chỉ thêm cancel-all.

## Task 1: Profile reservation và queue có ownership

**Files:** Modify `src/services/browser/BrowserProfileService.ts:119–304`; create `src/services/browser/ProfileJobQueue.ts`; test `src/__tests__/browser/BrowserProfileService.test.ts`, create `src/__tests__/browser/ProfileJobQueue.test.ts`; update SYSTEM_DOCUMENTATION khi contract nội bộ đổi.

**Interfaces — produces:**
- Trong BrowserProfileService: `AutomationReservation { readonly profileId:string }` chỉ có hiệu lực bằng object identity trong service, không thể tự dựng từ ID. `tryReserveAutomation(profileId:string): AutomationReservation|null`; `canReserveAutomation(profileId:string):boolean`; `releaseAutomationReservation(token:AutomationReservation):void`; `onAvailabilityChanged(listener:()=>void):()=>void`; `isIdle():boolean`; `waitUntilIdle(timeoutMs:number):Promise<boolean>`. `openForAutomation(profileId:string, reservation?:AutomationReservation):Promise<AutomationSession>` giữ caller một tham số nhưng không được vượt reservation của job khác.
- Trong ProfileJobQueue: `ProfileJobOwner={workspaceId:string; generation:number; jobId:string}`; `ProfileJobPriority='scheduled'|'interactive'|'background'`; `ProfileTaskContext={jobId:string; signal:AbortSignal; priority:ProfileJobPriority; deadlineAt?:number; assertCurrent:()=>void; onWaiting?:(reason:string)=>void}`; `ProfileJobRequest=Omit<ProfileTaskContext,'jobId'> & {owner:ProfileJobOwner; profileId:string}`.
- `ProfileJobLease={profileId:string; open():Promise<AutomationSession>; release():void}`. `ProfileJobQueue` constructor deps `{browser:BrowserProfileService; now?:()=>number; deferUntil?:(request:ProfileJobRequest,now:number)=>number|null; onChanged?:()=>void}`. Methods `acquire(request):Promise<ProfileJobLease>`, `open(request):Promise<AutomationSession>` (một session, close/error tự release đúng lease), `canAcquire(profileId:string):boolean`, `isBusy():boolean`, `notifyAvailability():void`, `pause():void`, `resume():void`, `retire():void`, `waitUntilIdle(timeoutMs:number):Promise<boolean>`. `PROFILE_JOB_WAIT_MS=7200000`; lỗi chờ có `code:'profile_wait_timeout'|'profile_wait_cancelled'`, không gom auth/launch errors vào chúng.

- [ ] **Step 1 — RED assertions:** thêm ca dùng fake process/context và đồng hồ Jest, không browser thật; mỗi ca dựng queue/service mới.
```ts
// concurrent owners/manual opens, 30-slot boundary, priority/FIFO, cancellation
expect(maxSimultaneousControllersForProfile).toBe(1);
expect(maxReservedOrRunningProfiles).toBe(30);
expect(order).toEqual(['scheduled-first', 'scheduled-second', 'interactive', 'background']);
expect(timedOut.code).toBe('profile_wait_timeout'); // clock đúng 7_200_000 ms
expect(await browser.waitUntilIdle(1)).toBe(false); // close timeout, chưa có close/exit
expect(otherProfileStarted).toBe(true);
```
Bao gồm abort trước grant và sau grant, 50 contenders, manual open giữa hai lần open của cùng lease, late release/token giả, cancel pending proxy/launch, context.close reject, closeAll, profile bị xóa trong khi chờ. `open()` fail trước spawn phải giải phóng; khi chưa rõ browser sống/chết phải giữ blocked.

**Làm rõ khi tích hợp Task 2:** giải phóng khi open thất bại ở trên áp dụng cho `queue.open(request)` dùng một session. `lease.open()` của lease đã acquire phải giữ quyền hợp lệ qua lỗi launch tạm thời để worker retry/reopen theo Task 2; worker giải phóng trong cleanup cuối cùng. Task 2 sửa hẹp queue và test thật worker+queue cho retry, chặn contender, convenience-failure cleanup và native-close chưa xác nhận. Không bỏ guard authority/abort/retire.
- [ ] **Step 2 — Run RED:** `npm test -- --runInBand src/__tests__/browser/BrowserProfileService.test.ts src/__tests__/browser/ProfileJobQueue.test.ts`; ghi tên ca và failure đúng hành vi. Nếu module chưa tồn tại, sau skeleton phải có failure assertion trước implementation.
- [ ] **Step 3 — Implement:** reservation và running dùng cùng authority trong BrowserProfileService; capacity đếm union profile IDs, không cộng hai lần reservation + browser của cùng profile. Manual/direct automation bị từ chối khi reserved; release có browser chưa kết thúc chỉ đánh dấu pending-release. Close timeout/reject không xóa running/reservation; chỉ close thành công/close event/exit xác nhận mới giải phóng. Pending spawn bị hủy vẫn được theo dõi tới cleanup, bắt late context/process rồi đóng đúng entry; capture profile directory trước await. Giữ SIGINT/SIGKILL, forwarder và sandbox hiện tại. Queue cấp đồng bộ, chống pump reentry; FIFO trong priority, không head-of-line blocking giữa profile khác. Deadline là min(request deadline, thời điểm enqueue + 2h), dùng event và timer deadline/defer gần nhất; abort đã grant không tự đóng critical session. `pause` ngừng admission và hủy waiter, `resume` chỉ cho cùng generation chưa retire; `retire` vĩnh viễn, cleanup token cũ vẫn được phép. Queue busy bao gồm lease đã release nhưng browser còn chưa xác nhận dừng.
- [ ] **Step 4 — GREEN/review:** chạy lại lệnh Step 2, cả hai TypeScript configs và docs-check. Review tests closeAll cũ: thay kỳ vọng “clear state ngay” bằng cleanup xác nhận, giữ mọi ca cancel/proxy/force-kill. Không gọi thay đổi này đã kiểm chứng browser live.

## Task 2: Worker một lượt và coordinator hai lượt

**Files:** Create `src/services/facebookPoster/FacebookPosterCoordinator.ts`; modify `FacebookPosterService.ts:27–51,136–182,203–249,345–448` và constructor deps trong `electron/ipc/facebookPosterIpc.ts`; tests `FacebookPosterService.test.ts`, mocks của deps bị đổi và create `src/__tests__/facebookPoster/FacebookPosterCoordinator.test.ts`. Constructor adapter phải đổi cùng worker để task này vẫn type-check; chuyển toàn bộ composition sang coordinator/side queues ở Task 3.

**Interfaces:** Consumes Task 1 context/lease. Worker thêm `acquireProfile(profileId:string,context:ProfileTaskContext):Promise<ProfileJobLease>` vào deps và `RunStartOptions={priority?:ProfileJobPriority; deadlineAt?:number}` vào tham số thứ ba của `start(params,scheduleId?,options?)`. `ProfileProgress.waitingReason?:string`. Export `RunSnapshot={run:FbPosterRun;progress:ProgressSnapshot}`. Coordinator deps `{store:FacebookPosterStore; createWorker:(runId:string)=>FacebookPosterService; newId?:()=>string; onChanged?:()=>void}`; factory bind worker `newId:()=>runId`. `MAX_ACTIVE_POSTER_RUNS=2`; methods `start(params:StartParams,scheduleId?:string,options?:RunStartOptions):{runId:string}`, `active():RunSnapshot[]`, `current():RunSnapshot|null`, `cancel(runId?:string):boolean`, `cancelAll():void`, `hasCapacity():boolean`, `isBusy():boolean`, `whenIdle():Promise<void>`, `stopAndWait(graceMs?:number,forceMs?:number):Promise<boolean>`, `pause():void`, `resume():void`. Export `PosterRunSelectionError` với `code:'CONFLICT'|'NOT_FOUND'`.

- [ ] **Step 1 — RED assertions:** dùng service/store thật với task/browser boundary giả; hai run có promise gate độc lập.
```ts
expect(coordinator.active().map(x => x.run.id)).toEqual(['run-a', 'run-b']);
expect(() => coordinator.start(thirdParams)).toThrow(BUSY_ERROR);
expect(store.listRuns({}).length).toBe(2); // không có run thứ ba
expect(() => coordinator.cancel()).toThrow(PosterRunSelectionError);
expect(coordinator.cancel('run-a')).toBe(true);
expect(coordinator.active().some(x => x.run.id === 'run-b')).toBe(true);
```
Thêm nested params/media mutation sau start; createRun/guard/factory throw; callback reenter start; instant completion; hủy waiting/open/critical; join hai session giữ cùng lease; expired grant sau wait không effect; late cleanup không xóa entry mới. Current sort startedAt rồi runId; unknown ID throw NOT_FOUND, finished ID false, zero active no-ID false ở core.
- [ ] **Step 2 — RED command:** `npm test -- --runInBand src/__tests__/facebookPoster/FacebookPosterCoordinator.test.ts src/__tests__/facebookPoster/FacebookPosterService.test.ts`.
- [ ] **Step 3 — Implement:** reserve coordinator admission trước injected callbacks, snapshot params bằng native structured clone; start failure trả slot nhưng không rollback effect đã xảy ra. Worker lấy một lease ở đầu profile plan, giữ `waiting` tới grant rồi mới `running`; release sau cleanup toàn bộ sessions, không đổi retry/critical journal. AbortController từng worker hủy waiter, không tự đóng critical browser. Dùng lease.open cho mọi lần reopen, lỗi chờ không đi vào retry launch 10s. Coordinator bao worker, không nhân recovery/DB init; cleanup map so identity và notify capacity sau worker settled để scheduler không bỏ lỡ wake. stopAndWait chạy các worker song song trong ngân sách grace 45s + force 10s, không cộng timeout theo số worker. Cancel có ID chỉ tìm captured store và active map, không fallback sang current. Tại constructor IPC hiện có, bind queue/owner/generation và acquireProfile thật với captured DB ngay trong task này; Task 3 dùng lại queue đó cho coordinator và side jobs, không tạo queue thứ hai hoặc thêm fallback chỉ để qua compile.
- [ ] **Step 4 — GREEN/review:** chạy lại Step 2 và cả hai TypeScript configs; kiểm post/scan/join/comments và first-comment/retry/uncertain tests hiện có. Ghi limits/waitingReason trong SYSTEM_DOCUMENTATION, thêm docs-check cho hằng số 2 và 7.200.000 tại task sở hữu file mới.

## Task 3: Side services và composition dùng tài nguyên theo job

**Files:** Modify `electron/ipc/facebookPosterIpc.ts:66–489`, `electron/ipc/researchIpc.ts`; `loginCheck.ts`, `PostTracker.ts`, `CommentCollector.ts`, `PageLearner.ts`, `ResearchService.ts`, `profileRotation.ts` nếu cần phân biệt busy; tests existing `loginCheck.test.ts`, `PostTracker.test.ts`, `CommentCollector.test.ts`, `dailyBrief/pageIdentity.test.ts`, `research/ResearchService.test.ts`, `research/researchIpc.test.ts`, `facebookPosterIpcWiring.test.ts`.

**Interfaces:** Consumes Tasks 1–2. Side deps thêm context vào `openForAutomation(id,context)`, `PostTracker.openSession(id,context)`, `CommentCollector.launchFor(id,context)`; Research giữ callback guard thứ hai và thêm context thứ ba: `openSession(id,assertCurrent,context)`. Tất cả context là `ProfileTaskContext` từ Task 1. Job/check/scan ID hiện có là context.jobId; generation do composition cấp, không nhận từ request. Remove global slot dependency khi đã chuyển tất cả consumers; không dùng slot no-op để né giới hạn. Composition có factory worker thật và một queue theo captured DB/workspace/generation. Mỗi side service thêm AbortController riêng, local admission trước callback, cùng isRunning/status/cancel/stop public như cũ.

- [ ] **Step 1 — RED assertions:** kiểm mỗi cặp poster + research/learn/login/track/collect bằng deferred boundaries; current job IDs thực, không chỉ assert mock acquire.
```ts
expect(await progressedBeforePosterFinished('profile-b')).toBe(true);
expect(sameProfileBrowserCount).toBe(1);
expect(secondSameServiceRequest).toThrow(BUSY_ERROR);
expect(pinnedResearchProfileIds).toEqual(['profile-a']);
expect(newWorkspaceWrites).toEqual([]);
expect(leadEventsByRun).toEqual(expectedSeparateBatches);
```
Hủy đang chờ phải settle không mở browser. Research explicit/pinned profile bận đợi; auto-selection dùng profile rảnh trước, nếu chỉ còn eligible-busy thì đợi trong chính tập được phép. Không bỏ login/excluded/daily-cap checks để làm busy eligible. PageLearner + Research khác profile cùng chạy; revocation khi đang chờ vẫn chặn. Kiểm local reentry ở LoginChecker/Tracker/Collector trước chọn rows/ID callbacks.
- [ ] **Step 2 — RED command:** `npm test -- --runInBand src/__tests__/facebookPoster src/__tests__/research src/__tests__/dailyBrief/pageIdentity.test.ts`.
- [ ] **Step 3 — Implement:** wiring dùng queue.open cho single-session side jobs và queue.acquire cho poster plans; adapters GraphqlSession/openLoggedInSession giữ auth/identity/error cleanup. Store/config/diagnostics/detector/login-observation/event handlers capture DB và generation; `getPageLearner().store` không đi theo singleton mới. Mỗi worker có manual leads/AI state riêng trong closure; flush theo finished runId. Thay single `campaignExecutionRunId` bằng tập IDs, chỉ thêm khi start được nhận, xóa đúng completion; retire mọi managed run, không hủy manual run khác khi chỉ revoke campaign runtime. `pruneDiagnostics` nhận toàn bộ active IDs. Profile list lấy union tất cả active plans; research không dùng busy union để bỏ hẳn pinned target. PageLearner không còn global `isResearchRunning` admission, nhưng giữ freshness/pause/own-one-job. Event/read/write guard stale sau await, cleanup luôn làm được trên owner cũ.
- [ ] **Step 4 — GREEN/review:** Step 2, cả hai TypeScript configs; đối chiếu tất cả constructors/mocks của deps đổi. Tái sử dụng real SQLite và existing store fixtures. Ghi thay đổi shared slot/limits vào SYSTEM_DOCUMENTATION; không nhận AI provider live đã được kiểm.

## Task 4: Scheduler không chặn lịch dùng profile độc lập

**Files:** Modify `FacebookPosterScheduler.ts:18–35,129–163,185–201`, composition `facebookPosterIpc.ts:737–873`, `LoginCheckScheduler.ts`/`PostTrackScheduler.ts`/`CommentCollectScheduler.ts` chỉ nếu callbacks không đủ; tests các scheduler và `facebookPosterIpcWiring.test.ts`.

**Interfaces:** SchedulerDeps giữ `isBusy` nhưng nghĩa là không còn coordinator capacity/admission; thêm `canStart:(params:StartParams)=>boolean` kiểm ít nhất một profile có thể nhận. `startRun(params,scheduleId,options:RunStartOptions):{runId:string}` truyền `priority:'scheduled'`, `deadlineAt:enqueuedAt+QUEUE_MAX_WAIT_MS`. `onResourcesChanged():void` pump lại hàng; `onRunFinished()` vẫn hoạt động. Queue `deferUntil` do composition tính theo profile: giữ nhường lịch sắp đến 10 phút, tối đa 1 giờ của background reads hiện có nhưng không chặn profile khác; `notifyAvailability` khi schedule/capacity đổi. Interactive job không bị future-schedule deferral, due scheduled waiter vẫn ưu tiên.

- [ ] **Step 1 — RED assertions:** lịch X dùng A bận, Y dùng B rảnh và còn một slot; queue không mất X, không tạo fake run. Kiểm timer tại boundary, update/delete/draft/revoke khi queued, recurring/once và owner bypass.
```ts
expect(startedSchedules).toEqual(['schedule-y']);
expect(scheduler.queuedIds()).toContain('schedule-x');
expect(startOptions.deadlineAt).toBe(enqueuedAt + 7_200_000);
expect(missedAtDeadline.reason).toBe(MISSED_QUEUE_TIMEOUT);
expect(backgroundOnOtherProfileStarted).toBe(true);
expect(timerRearmDelays.every(ms => ms > 0)).toBe(true); // không spin tại đúng deadline
```
Hết worker capacity giữ queued, không tạo run/tiêu attempt. Lịch được nhận rồi đợi profile thứ hai vẫn dùng deadline cũ. Background cùng profile nhường tương ứng nhưng không bị starvation vô hạn.
- [ ] **Step 2 — RED command:** `npm test -- --runInBand src/__tests__/facebookPoster/FacebookPosterScheduler.test.ts src/__tests__/facebookPoster/LoginCheckScheduler.test.ts src/__tests__/facebookPoster/PostTrackScheduler.test.ts src/__tests__/facebookPoster/CommentCollectScheduler.test.ts src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts`.
- [ ] **Step 3 — Implement:** xét toàn bộ queue hợp lệ thay vì shift rồi break vì profile bận; giới hạn mỗi pump bằng queue snapshot, reserve qua coordinator, revalidate authority/media trước admission và effect. Không dispatch lịch chỉ để chiếm slot chờ nếu tất cả profiles bận. Timer lấy deadline nhỏ nhất của mọi item, xử lý equality không zero-delay loop. Side timer isBusy chỉ gồm own job/lifecycle, priority chuyển xuống queue theo profile; bỏ các global poster-busy/scheduleWantsSlot admissions còn sót ở campaign tracking và research, giữ research/campaign tracker own single-job. Không sửa fail-closed autonomy thành legacy fail-open, không bỏ error backoff.
- [ ] **Step 4 — GREEN/review:** Step 2 và campaign integration suites; cập nhật docs cho capacity/profile wait, giữ grace/timeout/missed reasons và max schedules 200.

## Task 5: Workspace, update và quit chờ toàn bộ owner

**Files:** Modify `electron/ipc/facebookPosterIpc.ts:126–133,524–583`, `workspaceIpc.ts:103–128`, `browserProfileIpc.ts`, `updateIpc.ts`, `electron/main.ts:512–520,1306–1371`; create `src/services/app/quitGuard.ts`; tests `app/workspaceIpc.test.ts`, `update/UpdateService.test.ts`, `facebookPosterIpcWiring.test.ts`, create `src/__tests__/app/quitGuard.test.ts`.

**Interfaces:** giữ `cancelFacebookPosterJobs():void`, `cancelAndWaitFacebookPosterJobs():Promise<boolean>`, `isFacebookPosterBusy():boolean`; aggregate gồm mọi poster worker, checker, learner, research, tracker/campaign tracker, collector, waiter và pending-release lease. Thêm `pauseFacebookJobAdmission():void`, `resumeFacebookJobAdmission():void` cho cùng generation nếu switch/quit thất bại. Browser IPC thêm `closeAllBrowserProfilesAndWait(timeoutMs:number):Promise<boolean>`. `createQuitGuard(deps:{drain:()=>Promise<boolean>; onReady:()=>void; onBlocked:()=>void}):()=>Promise<boolean>` coalesce các request đang drain, cho retry sau false, onReady một lần khi true.

- [ ] **Step 1 — RED assertions:** hai worker và một side waiter, một browser close treo; thử switch, delete active workspace, update, renderer quit và OS before-quit.
```ts
expect(dbCloseCalls).toBe(0); // timeout hoặc còn pending launch/close
expect(newJobAcceptedDuringDrain).toBe(false);
expect(readyCalls).toBe(1); // double quit, drain resolve true
expect(oldGenerationWritesIntoReopenedWorkspace).toEqual([]);
expect(updateInstallCallsWhileSideJobWaiting).toBe(0);
```
Thêm false drain → resume đúng workspace, attempt tiếp theo thành công, callback cũ sau A→B→A, multiple managed runs bị retire, critical uncertain vẫn settle trước DB close. Không chỉ test helper mà kiểm wiring before-quit/renderer quit không bypass.
- [ ] **Step 2 — RED command:** `npm test -- --runInBand src/__tests__/app src/__tests__/update/UpdateService.test.ts src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts src/__tests__/control/controlWiring.test.ts`.
- [ ] **Step 3 — Implement:** đóng admission trước await, dừng scheduler, abort waiters, hủy/drain all workers/side jobs theo timeout có hạn và browser confirmation. Không đóng DB nếu false; giữ thông báo hiện có, resume admission/scheduler cùng generation trên switch thất bại, retire queue cũ khi switch thành công. Before-quit preventDefault tới khi guard true, sau đó một lần app.quit đi qua cleanup hiện có. Timer force-exit 5s từ renderer không được bypass drain; không thay bằng force-close DB ở timeout. Giữ cleanup unrelated services nhưng chạy sau gate an toàn, không restart chúng trong task. Updater dùng aggregate thực, không chỉ current run.
- [ ] **Step 4 — GREEN/review:** Step 2, TypeScript; cập nhật SYSTEM_DOCUMENTATION và README về quit nay có thể bị chặn khi chưa drain, không còn hứa thoát ngay. Việc đổi quit này là yêu cầu spec, không được bỏ khỏi nghiệm thu hoặc tự coi đã chứng minh OS/browser live.

## Task 6: Active/cancel API, IPC và bridge tương thích

**Files:** Modify `electron/ipc/facebookPosterIpc.ts:910–921,1024–1046,1287–1291`, `electron/preload.ts:952–957`, `src/ui/lib/ipc.ts:731–737`, `src/services/control/ControlMethods.ts:48–63,102–115,493–519`, `tools/maihub-bridge/maihub_bridge.py` guidance; tests ControlMethods/ControlApiServer/controlAuthorization/facebookPosterIpcWiring và `tools/maihub-bridge/tests/test_bridge.py`; protocol và bridge README.

**Interfaces:** operation `active():{runs:RunSnapshot[]}`; IPC `facebookPoster:active` → `{success:true,runs}`. Preload/global type `active():Promise<{success:boolean;runs?:RunSnapshot[];error?:string}>`, `cancel(runId?:string):Promise<{success:boolean;cancelled?:boolean;error?:string}>`; preload gửi `{runId}` khi có, không gửi object ID thành string. Operation `cancel(params?:{runId?:string}):{cancelled:boolean}`. HTTP `runs.active` no params → `result:RunSnapshot[]`; `runs.cancel({confirm:true,runId?:string})` → `{cancelled:boolean}`. No-ID 0/1 giữ legacy acknowledgment true; explicit terminal ID false; unknown/wrong-workspace NOT_FOUND; no-ID nhiều active CONFLICT. Current operation/HTTP shape `{run,progress}` giữ null fields khi rỗng, earliest startedAt/runId khi nhiều.

- [ ] **Step 1 — RED assertions:** real registry/IPC adapters, validation và authorization trước action.
```ts
expect(await call('runs.active', {})).toEqual([]); // helper unwraps result
expect(await call('runs.cancel', {confirm:true,runId:finishedId})).toEqual({cancelled:false});
expect((await failedCall('runs.cancel', {confirm:true})).code).toBe('CONFLICT'); // hai run sống
expect(scopedMethodNames).not.toContain('runs.active');
expect(cancelledRunIds).toEqual([requestedId]);
```
Bao gồm empty/non-string ID, missing confirm, no-ID zero/one, identity lookup không đọc DB khác, direct forbidden call, same idempotency key khác runId, revoke/context đổi khi request đang chạy; Python dynamic tools forward runId đúng và hiển thị conflict, không có owner fallback.
- [ ] **Step 2 — RED command:** `npm test -- --runInBand src/__tests__/control src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts`; `python3 -m unittest discover -s tools/maihub-bridge/tests`.
- [ ] **Step 3 — Implement:** thêm registry/port/IPC/preload/types cùng nhau; runtime validate ID như runs.get, map `PosterRunSelectionError` rõ sang ControlFault codes thay vì plain Error→INVALID_PARAMS. Confirm/RBAC/captured context/audit/idempotency giữ hiện tại; không thêm runs.* vào scoped allowlists. `system.status.currentRun` vẫn compatibility view, không dùng cho aggregate busy. Bridge đã sinh tools từ filtered describe nên chỉ sửa guidance/schema tests, không adapter mới; ghi cần refresh cached catalog để thấy method mới. Hủy true là acknowledgment, không terminal proof.
- [ ] **Step 4 — GREEN/review:** Step 2, TypeScript, docs-check; rà toàn bộ callers cancel/current. Cập nhật protocol/bridge examples explicit runId và compatibility, không nới các schema/event/status legacy khác.

## Task 7: Composer độc lập, chọn run và log theo ID

**Files:** Create `src/ui/features/facebookPoster/runState.ts`; modify năm components nêu trong file map, global IPC type nếu cần dùng shared type-only imports; create `src/__tests__/facebookPoster/runState.test.ts`; update `DESIGN.md` poster rationale và SYSTEM_DOCUMENTATION. Không thêm jsdom/testing library hoặc `.test.tsx` mà Jest hiện không chạy.

**Interfaces:** `PosterRunState={runs:Record<string,RunSnapshot>;logs:Record<string,PosterLog[]>;selectedRunId:string|null}`; `PosterLog={runId:string;profileId:string;level:string;message:string;at:number}`. Export `initialRunState:PosterRunState`; `reduceRunState(state:PosterRunState,action:PosterRunAction):PosterRunState`, union actions `{type:'reconcile';runs:RunSnapshot[]}`, `{type:'select';runId:string}`, `{type:'log';entry:PosterLog}`, `{type:'progress';progress:ProgressSnapshot}`, `{type:'finished';runId:string;status:FbPosterRun['status']}`. `onStarted(runId:string):void` xuyên Post/Join/Comments; RunPanel nhận selected snapshot như cũ nhưng cancel explicit captured ID.

- [ ] **Step 1 — RED assertions:** reducer thực thuần Node; render interactions kiểm qua Playwright dùng IPC giả, không mock reducer.
```ts
expect(state.logs['run-a']).toHaveLength(500);
expect(state.logs['run-b'][0].runId).toBe('run-b');
expect(Object.keys(state.logs).length).toBeLessThanOrEqual(3);
expect(selectedAfterUnrelatedEvent).toBe(selectedBefore);
expect(runFinishedDuringBootstrap.status).toBe('done');
expect(cancelRequest.runId).toBe(idBeforeConfirmOpened);
```
Composer A đang đăng → sửa/lưu B không đổi A; scan hoàn tất không ghi đè B, chọn run trong confirm không đổi cancel target; double-submit start/rescan/save chỉ một request tương ứng; loading/error/empty, cancel failed/terminal, tab switch và view remount giữ dữ liệu đúng.
- [ ] **Step 2 — RED command:** `npm test -- --runInBand src/__tests__/facebookPoster/runState.test.ts`; dựng render harness trong scratch bằng Vite có sẵn và chạy Playwright các thao tác trước đổi component, lưu assertion failure/screenshot. Chặn mọi network ngoài local harness, stub IPC trước module load; không khởi động Electron với userData thật.
- [ ] **Step 3 — Implement:** subscribe events trước active fetch, buffer chỉ trong một bootstrap request rồi reconcile snapshot và replay events theo thứ tự; chặn stale response sau unmount/workspace generation, clear buffer sau settle. Event run không biết metadata phải reconcile/fetch getRun theo ID, không đổi selection tự động. Reducer giới hạn cache, tombstone finished trong bootstrap để snapshot muộn không hồi sinh, selected lịch sử dùng getRun. Post/Join/Comments chỉ khóa thao tác đang submit và validation/capacity tương ứng, không khóa editor bởi active run khác; rescan có in-flight flag riêng. onStarted dùng ID trả về, không đoán từ current. Tái dùng RunPanel/showConfirm/tokens, giữ draft validation, media snapshot, preview, groups/variants/scheduling và read/export/CRM của Comments. Mỗi run có waitingReason và hủy riêng; chọn ID trước await showConfirm.
- [ ] **Step 4 — GREEN/render review:** Step 2, TypeScript; desktop 1440×900 và mobile 390×844, light/dark. Assert document scrollWidth≤clientWidth, không đè text/controls, focus keyboard, thao tác chính không pending mãi; chụp ảnh từng tổ hợp. Dùng các tab/case trên, không nhận chỉ screenshot tĩnh là functional pass. Cập nhật dòng “Một việc một lúc” trong DESIGN.md sang các bất biến mới, không đổi palette/layout toàn app.

## Task 8: Composition stress, regression và bàn giao

**Files:** Create `src/__tests__/facebookPoster/backgroundJobs.integration.test.ts`; extend relevant existing suites; update `SYSTEM_DOCUMENTATION.md`, `README.md`, protocol và `scripts/check-docs.js` cho constants đã thêm. Cập nhật Trạng thái/ghi chú spec và plan sau triển khai, không viết lại thân lịch sử.

**Interfaces:** Consumes toàn bộ Tasks 1–7. Suite dùng coordinator/service/queue/browser lifecycle/store/registry thật, fake native launch/process/clock/provider transport. Dùng temp SQLite dưới scratch; không fake coordinator.start hoặc queue.acquire để “chứng minh” concurrency.

- [ ] **Step 1 — Add missing RED cases:** hai run độc lập + mỗi side service; 50 competing starts và cancels, 30 profile capacity mixed manual/automation, 100 interleaved events, stale token/callback, close timeout, source mutation, partial schedule profile availability, deadline/revoke trong wait, A→B→A, crash-before/after-submit recovery, multiple managed execution retirement. Quota cùng Page không nhân, campaign first-comment restriction vẫn giữ. Soạn/save/video view dùng fake render boundary không giữ browser lock; không gọi provider thật. Assertion ví dụ:
```ts
expect(realStore.listRuns({}).filter(x => x.status === 'running').length).toBeLessThanOrEqual(2);
expect(maxNativeProfiles).toBeLessThanOrEqual(30);
expect(crossWorkspaceEffects).toEqual([]);
expect(replayedUncertainPublishes).toBe(0);
expect(pageQuotaUsed).toBe(expectedSharedQuota);
```
Ca đã xanh ở implementation trước được gọi regression verification, không giả RED→GREEN; ca thiếu phải có failure thực trước sửa local module sở hữu, không thay assertion để qua.
- [ ] **Step 2 — Targeted check:** `npm test -- --runInBand src/__tests__/facebookPoster/backgroundJobs.integration.test.ts src/__tests__/dailyBrief/pageCampaignAutonomy.integration.test.ts src/__tests__/dailyBrief/pageOperations.integration.test.ts`; sửa đúng module nếu phát hiện lỗi, quay lại scoped review task đó.
- [ ] **Step 3 — Hai vòng độc lập:** với `TMPDIR="$SCRATCH"`, vòng 1 `TZ=America/New_York npm test -- --runInBand --no-cache --cacheDirectory="$SCRATCH/jest-cache" --randomize --seed=2707 --showSeed`; vòng 2 tương tự `TZ=Asia/Ho_Chi_Minh`, seed `3707`. Mỗi vòng chạy Python suite, cả hai `tsc --noEmit -p tsconfig.json` / `tsconfig.electron.json`, docs-check, diff-check và ma trận UI Task 7; kiểm branch/source freeze và lưu logs/screenshot trong scratch. Không skip tests lỗi, liệt kê warnings/failures có thật.
- [ ] **Step 4 — Build/lint gates:** chạy `make build`, `make test`, `make lint` và paste output, không nhận thiếu target là pass. Khi không có Make targets, chỉ có thể ghi blocker; không tự thêm. Build production artifact bằng script hiện có chỉ khi môi trường/dev dependencies đáp ứng và không đụng dữ liệu khách; npm production có native rebuild nên cần xác nhận riêng trước side effects đó. Không nhận `tsc --noEmit` hoặc fixture UI là installer/live verification. Không deploy trong kế hoạch này.
- [ ] **Step 5 — Review/bàn giao:** controller review actual scoped diff sau mỗi task, cuối plan một broad review; fix findings rồi reverify affected/full suites. Báo rõ behaviors đã kiểm và chưa kiểm: draft/media/variants, post/scan/join/comments, login/research/learn/tracking/leads, schedules/recovery, API/bridge scopes/idempotency, workspace/update/quit, UI themes/actions. Nếu Make/live/packaging gate vẫn thiếu, trạng thái local verification tương ứng và release BLOCKED; không ghi hoàn tất tổng thể.

## Dependency và phương thức thực thi

Thứ tự an toàn: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8**. Các task chia sẻ composition/contracts nên không giao nhiều implementer cùng sửa file. Có thể song song việc đọc độc lập hoặc chuẩn bị test fixtures không chạm phần đang sửa; controller vẫn giữ task review và broad review. Không giao lại tám task campaign đã hoàn thành trong plan ngày 29/10.

Thực thi sau khi anh duyệt plan: subagent theo task, review spec compliance + quality từng task, controller tự kiểm chứng cuối. Không commit theo mặc định: thay bước commit trong quy trình bằng scoped diff + báo cáo/ledger tại scratch; nếu anh cho commit sau này, code/docs liên quan cùng commit và giữ attribution bắt buộc. Rollback chỉ hunks/file mới của đợt này, không reset/stash/clean dirty work khác hoặc xóa journal/evidence.

## Self-review trước trình duyệt

- Spec §§1–3: mục tiêu/scope/limits có Tasks 1–3, 7; không thêm ROI/autonomy/comment executor.
- Spec §§4–5: resource ownership, captured workspace, drain/recovery ở Tasks 1–3, 5, 8; giữ closed-browser proof thay vì release ở timeout.
- Spec §6: scheduling/legacy API envelopes/cancel ambiguity ở Tasks 4, 6; current singular chỉ là compatibility view.
- Spec §7: composer's snapshot, per-run cache/cancel và bootstrap race ở Task 7; các assertion Node chạy được với Jest config hiện tại.
- Spec §§8–9: matrix, hai rounds, desktop/mobile/themes, docs và release gates ở Task 8. Năm Review Focus đều có ca kiểm ở task sở hữu; signatures dùng thống nhất, không placeholder hoặc type chưa được task định nghĩa.

## Ghi chú sau triển khai

Đã bắt đầu triển khai sau khi anh duyệt kế hoạch và yêu cầu dùng subagent ngày 2026-10-30. Task 1 đã qua review độc lập trong phạm vi reservation/queue: 51 tests tập trung đạt ở hai vòng; full Jest 126 suites/3178 tests đạt; controller kiểm lại focused/type/docs/diff đều exit 0. Chưa tích hợp coordinator/side services/UI/lifecycle; native DB façade hiện có phải được bind theo workspace tại Task 5. Output full suite còn cảnh báo/lỗi console baseline, Make targets vẫn thiếu. Task 2 đã qua review và re-review hẹp sau khi sửa observer cached đi theo DB mới: giữ settlement tại DB cũ, chặn notification stale. Controller kiểm lại 5 suites/208 tests và cả hai TS/docs/diff exit 0; hai stress rounds cuối 52 suites/1086 tests mỗi vòng, full Jest 127 suites/3197 tests. Coordinator hiện là module đã kiểm thử, chưa ghép toàn bộ composition. Các Task 3–8 và nghiệm thu tổng thể chưa hoàn tất; không bật hoạt động thật.

Task 8 (2026-10-31, dev): thêm `backgroundJobs.integration.test.ts` (16 ca, composition thật với native/page/provider/clock giả) và 2 ca trong `pageCampaignAutonomy.integration.test.ts`; mọi ca background là regression verification trừ ca hai Page campaign đồng thời, RED thật (`clicks` 0/2, `LIMIT_EXCEEDED` chéo Page) rồi sửa `PageCampaignExecutionStore.ownerUsage` (module của kế hoạch campaign 29/10, lộ ra do coordinator 2 lượt Task 2). Targeted Step 2: 3 suites/60 tests exit 0. Hai vòng randomized: 131 suites, 3384/3387 đạt, 3 đỏ đều ở `facebookPosterIpcWiring.test.ts` (fixture phụ thuộc thứ tự từ Tasks 2–4, độc lập với bản sửa); Python bridge 368 OK, hai tsc, docs-check, diff-check exit 0, UI harness 288/0 mỗi vòng, source freeze OK. Full Jest thứ tự chuẩn 131/3387 exit 0 (12 console.error/2 console.warn như baseline). `make build/test/lint` exit 2 (không có target); vite/tsc build vào scratch exit 0; packaging/native rebuild chưa chạy, cần anh xác nhận. Release BLOCKED, không ghi hoàn tất tổng thể. Fix-1 (controller duyệt, test-only): wiring tests tự dựng worker generation hiện tại, deferral dùng profile riêng; RED seeds 2707/3707 (3 đỏ mỗi seed) → GREEN 2707/3707/4711 và thứ tự chuẩn 60/60; chạy lại hai vòng 131 suites/3387 tests exit 0 mỗi vòng (12 error/2 warn), bridge 368, hai tsc/docs/diff exit 0, UI 288/0, source freeze OK; full thứ tự chuẩn 131/3387 exit 0. Seed khác (2, 42, 123456) còn đỏ dây chuyền do `afterEach` nhóm PageLearner để admission tạm dừng. Fix-2: (A) scoped review quota yêu cầu chỉ bỏ qua execution Page khác còn `reserved`; RED unit test execution `cancelled` + owner run cùng Page (`beginSubmit` không ném) → GREEN, thêm test reserved Page khác không tính/cùng Page vẫn tính và ca integration owner + campaign cùng Page (một bài). (B) test-only: teardown PageLearner drain → retire → dựng generation mới; ba test scheduler thật xóa lịch sót. RED seeds 2/42/123456/9001/3 = 38/35/31/3/1 đỏ → 60/60. Kết quả cuối: hai vòng 131 suites/3391 tests exit 0 (12 error/2 warn), bridge 368, hai tsc/docs/diff exit 0, UI 288/0, source freeze OK; seed UTC 1/2/3/42/9001/123456 và thứ tự chuẩn đều 3391/3391. Fix-3 (review Task 8, test/docs-only): IPC registry dùng clock giả để b bắt đầu sau a + ca trùng mili giây sắp theo runId; restart thay bằng occurrence owner once/recurring bị ngắt sau submit (DB handle tiến trình cũ bị vô hiệu, timer bị xóa), đột biến tạm re-arm trong `failInterruptedRuns` làm 2 ca đỏ, khôi phục file trùng baseline; ca hai profile cùng Page (`duplicate`) trong autonomy suite; afterEach về real timers trước drain, rmSync trong finally, kiểm logs/events không chứa giá trị cookie; mô tả fake/stub chính xác. Suite background 19/19 ở seed 5150/2707/3707/1/42/77/8/99/2024 và thứ tự chuẩn. Hai vòng 131 suites/3395 tests exit 0 (12 error/2 warn), bridge 368, hai tsc/docs/diff exit 0, UI 288/0, source freeze OK; full thứ tự chuẩn 131/3395 exit 0. Fix-4 (test-only): ca restart/scheduler lệ thuộc giờ thật vì lượt kiểm tra đăng nhập hằng ngày mặc định 07:00 địa phương (`LoginCheckScheduler`, hành vi sản phẩm đúng) rơi vào cửa sổ tua 3 giờ ở UTC/London; fixture tắt nó qua khóa `fb_poster_login_check`, ghim clock `T0`, dựng composition lazy sau clock giả và giữ thời điểm khi `clearAllTimers`. Suite 19/19 ở 7 múi giờ × (thứ tự chuẩn, 5150, 2707, 3707); đột biến re-arm vẫn làm 2 ca đỏ; hai vòng 131/3395 exit 0, full UTC thứ tự chuẩn 131/3395.

Sau review cuối (2026-10-31, dev): B3/F7 giải quyết theo phương án (a) anh chọn — quit bị chặn có **Thoát ngay** sau xác nhận hai bước (`forceQuit` một lần, không retire, `app.exit(0)`); cập nhật và chuyển workspace không đổi. Test trong `src/__tests__/app/quitGuard.test.ts` dùng harness main module thật; chưa kiểm hộp thoại native hay `app.exit` trên app Electron thật.
