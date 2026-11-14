package bridge

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

const testThread int64 = 111

func newHistoryTestClient() *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{Logger: zerolog.Nop(), ctx: ctx, cancel: cancel, threadCache: map[int64]*Thread{}, eventChan: make(chan *Event, 64)}
}

// fakeClock makes the grace window testable without sleeping.
func fakeClock(c *Client, start time.Time) *time.Time {
	now := start
	c.now = func() time.Time { return now }
	return &now
}

func drainMessageIDs(c *Client) []string {
	var ids []string
	for {
		select {
		case ev := <-c.eventChan:
			if m, ok := ev.Data.(*Message); ok && ev.Type == EventTypeMessage {
				ids = append(ids, m.ID)
			}
		default:
			return ids
		}
	}
}

func upsertTable(thread int64, ids ...string) *table.LSTable {
	tbl := &table.LSTable{LSInsertNewMessageRange: []*table.LSInsertNewMessageRange{{ThreadKey: thread, MinTimestampMs: 1000}}}
	for _, id := range ids {
		tbl.LSUpsertMessage = append(tbl.LSUpsertMessage, &table.LSUpsertMessage{ThreadKey: thread, MessageId: id, TimestampMs: 1000})
	}
	return tbl
}

func wrapped(thread int64, id string, ts int64) *table.WrappedMessage {
	return &table.WrappedMessage{LSInsertMessage: &table.LSInsertMessage{ThreadKey: thread, MessageId: id, TimestampMs: ts}}
}

func upsertOf(thread int64, rng *table.LSInsertNewMessageRange, msgs ...*table.WrappedMessage) map[int64]*table.UpsertMessages {
	return map[int64]*table.UpsertMessages{thread: {Range: rng, Messages: msgs}}
}

func mustRegister(t *testing.T, c *Client, thread, beforeTs int64) (*historyCollector, func()) {
	t.Helper()
	col, release, err := c.registerHistoryCollector(thread, beforeTs)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	return col, release
}

func await(t *testing.T, c *Client, col *historyCollector) *HistoryPage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	page, err := c.awaitHistoryPage(ctx, col, testThread)
	if err != nil {
		t.Fatalf("await: %v", err)
	}
	return page
}

func TestDeliverHistoryRangePage(t *testing.T) {
	c := newHistoryTestClient()
	col, release := mustRegister(t, c, testThread, 5000)
	defer release()
	rng := &table.LSInsertNewMessageRange{HasMoreBefore: true, MinTimestampMs: 1000, MinMessageId: "mid.$a"}
	claimed := c.deliverHistory(&table.LSTable{}, upsertOf(testThread, rng,
		wrapped(testThread, "mid.$a", 1000), wrapped(testThread, "mid.$c", 3000), wrapped(testThread, "mid.$b", 2000)))
	if !claimed[testThread] {
		t.Fatal("thread not claimed")
	}
	page := await(t, c, col)
	if len(page.Messages) != 3 || page.Messages[0].ID != "mid.$c" || page.Messages[2].ID != "mid.$a" {
		t.Fatalf("unexpected order: %+v", page.Messages)
	}
	if !page.HasMoreBefore || page.MinTimestampMs != 1000 || page.MinMessageID != "mid.$a" || page.ThreadID != "111" {
		t.Fatalf("unexpected page: %+v", page)
	}
}

func TestDeliverHistoryDeduplicates(t *testing.T) {
	c := newHistoryTestClient()
	col, release := mustRegister(t, c, testThread, 5000)
	defer release()
	c.deliverHistory(&table.LSTable{}, upsertOf(testThread, nil, wrapped(testThread, "mid.$a", 1000)))
	c.deliverHistory(&table.LSTable{}, upsertOf(testThread, nil, wrapped(testThread, "mid.$a", 1000)))
	if page := await(t, c, col); len(page.Messages) != 1 {
		t.Fatalf("want 1 message, got %d", len(page.Messages))
	}
}

func TestDeliverHistoryExistingRangeEndsChat(t *testing.T) {
	c := newHistoryTestClient()
	col, release := mustRegister(t, c, testThread, 5000)
	defer release()
	tbl := &table.LSTable{LSUpdateExistingMessageRange: []*table.LSUpdateExistingMessageRange{{ThreadKey: testThread, TimestampMS: 5000}}}
	if claimed := c.deliverHistory(tbl, nil); len(claimed) != 0 {
		t.Fatalf("nothing to claim, got %v", claimed)
	}
	page := await(t, c, col)
	if page.HasMoreBefore || page.Messages == nil || len(page.Messages) != 0 {
		t.Fatalf("unexpected page: %+v", page)
	}
}

func TestDeliverHistoryIgnoresOtherAnchor(t *testing.T) {
	c := newHistoryTestClient()
	col, release := mustRegister(t, c, testThread, 5000)
	defer release()
	tbl := &table.LSTable{LSUpdateExistingMessageRange: []*table.LSUpdateExistingMessageRange{{ThreadKey: testThread, TimestampMS: 4000}}}
	c.deliverHistory(tbl, nil)
	select {
	case <-col.done:
		t.Fatal("collector must keep waiting")
	default:
	}
}

func TestDeliverHistoryNoCollectorClaimsNothing(t *testing.T) {
	c := newHistoryTestClient()
	claimed := c.deliverHistory(&table.LSTable{}, upsertOf(testThread, nil, wrapped(testThread, "mid.$a", 1000)))
	if len(claimed) != 0 {
		t.Fatalf("want nothing claimed, got %v", claimed)
	}
}

func TestDeliverHistoryOtherThreadUntouched(t *testing.T) {
	c := newHistoryTestClient()
	col, release := mustRegister(t, c, testThread, 5000)
	defer release()
	claimed := c.deliverHistory(&table.LSTable{}, upsertOf(222, nil, wrapped(222, "mid.$x", 1000)))
	if claimed[222] || len(claimed) != 0 {
		t.Fatalf("other thread must not be claimed: %v", claimed)
	}
	select {
	case <-col.done:
		t.Fatal("collector must keep waiting")
	default:
	}
}

func TestRegisterRejectsSecondRequest(t *testing.T) {
	c := newHistoryTestClient()
	_, release := mustRegister(t, c, testThread, 5000)
	defer release()
	_, _, err := c.registerHistoryCollector(testThread, 6000)
	if err == nil || !strings.Contains(err.Error(), "history request already running for thread") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestAwaitTimesOutAndReleases(t *testing.T) {
	c := newHistoryTestClient()
	col, release := mustRegister(t, c, testThread, 5000)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := c.awaitHistoryPage(ctx, col, testThread)
	if err == nil || err.Error() != "timed out waiting for Messenger history" {
		t.Fatalf("unexpected error: %v", err)
	}
	release()
	_, release2, err := c.registerHistoryCollector(testThread, 5000)
	if err != nil {
		t.Fatalf("re-register after release: %v", err)
	}
	release2()
}

func TestAwaitDisconnected(t *testing.T) {
	c := newHistoryTestClient()
	col, release := mustRegister(t, c, testThread, 5000)
	defer release()
	c.cancel()
	_, err := c.awaitHistoryPage(context.Background(), col, testThread)
	if err == nil || err.Error() != "bridge disconnected" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestAwaitWithoutRangeUsesOldestMessage(t *testing.T) {
	c := newHistoryTestClient()
	col, release := mustRegister(t, c, testThread, 5000)
	defer release()
	c.deliverHistory(&table.LSTable{}, upsertOf(testThread, nil, wrapped(testThread, "mid.$new", 3000), wrapped(testThread, "mid.$old", 1000)))
	page := await(t, c, col)
	if !page.HasMoreBefore || page.MinTimestampMs != 1000 || page.MinMessageID != "mid.$old" {
		t.Fatalf("unexpected page: %+v", page)
	}
}

func TestLateAnswerAfterReleaseIsClaimed(t *testing.T) {
	c := newHistoryTestClient()
	fakeClock(c, time.Unix(1000, 0))
	col, release := mustRegister(t, c, testThread, 5000)
	release()
	claimed := c.deliverHistory(&table.LSTable{}, upsertOf(testThread, nil, wrapped(testThread, "mid.$late", 1000)))
	if !claimed[testThread] {
		t.Fatal("late answer must be claimed")
	}
	if len(col.messages) != 0 {
		t.Fatal("released collector must not collect")
	}
}

func TestTombstoneExpires(t *testing.T) {
	c := newHistoryTestClient()
	clock := fakeClock(c, time.Unix(1000, 0))
	_, release := mustRegister(t, c, testThread, 5000)
	release()
	*clock = clock.Add(historyGraceWindow + time.Second)
	if claimed := c.deliverHistory(&table.LSTable{}, upsertOf(testThread, nil, wrapped(testThread, "mid.$x", 1000))); len(claimed) != 0 {
		t.Fatalf("expired tombstone must not claim: %v", claimed)
	}
	if len(c.historyTombstones) != 0 {
		t.Fatal("expired tombstone must be pruned")
	}
}

func TestRegisterDuringGraceTakesOver(t *testing.T) {
	c := newHistoryTestClient()
	fakeClock(c, time.Unix(1000, 0))
	_, release := mustRegister(t, c, testThread, 5000)
	release()
	col, release2 := mustRegister(t, c, testThread, 4000)
	defer release2()
	c.deliverHistory(&table.LSTable{}, upsertOf(testThread, nil, wrapped(testThread, "mid.$n", 1000)))
	if page := await(t, c, col); len(page.Messages) != 1 {
		t.Fatalf("new request must collect, got %d", len(page.Messages))
	}
}

func TestTombstoneOtherThreadUnaffected(t *testing.T) {
	c := newHistoryTestClient()
	fakeClock(c, time.Unix(1000, 0))
	_, release := mustRegister(t, c, testThread, 5000)
	release()
	if claimed := c.deliverHistory(&table.LSTable{}, upsertOf(222, nil, wrapped(222, "mid.$x", 1000))); len(claimed) != 0 {
		t.Fatalf("other thread must not be claimed: %v", claimed)
	}
}

func TestHandleTableSkipsClaimedUpsertsOnly(t *testing.T) {
	c := newHistoryTestClient()
	_, release := mustRegister(t, c, testThread, 5000)
	defer release()
	tbl := upsertTable(testThread, "mid.$oldA")
	other := upsertTable(222, "mid.$oldB")
	tbl.LSInsertNewMessageRange = append(tbl.LSInsertNewMessageRange, other.LSInsertNewMessageRange...)
	tbl.LSUpsertMessage = append(tbl.LSUpsertMessage, other.LSUpsertMessage...)
	c.handleTable(tbl)
	ids := drainMessageIDs(c)
	if len(ids) != 1 || ids[0] != "mid.$oldB" {
		t.Fatalf("want only thread B emitted, got %v", ids)
	}
}

func TestHandleTableStillEmitsLiveInsertDuringWait(t *testing.T) {
	c := newHistoryTestClient()
	_, release := mustRegister(t, c, testThread, 5000)
	defer release()
	tbl := &table.LSTable{LSInsertMessage: []*table.LSInsertMessage{{ThreadKey: testThread, MessageId: "mid.$live", TimestampMs: 9000}}}
	c.handleTable(tbl)
	if ids := drainMessageIDs(c); len(ids) != 1 || ids[0] != "mid.$live" {
		t.Fatalf("live insert must still be emitted, got %v", ids)
	}
}

func TestHandleTableWithoutCollectorEmitsUpserts(t *testing.T) {
	c := newHistoryTestClient()
	c.handleTable(upsertTable(testThread, "mid.$a", "mid.$b"))
	if ids := drainMessageIDs(c); len(ids) != 2 {
		t.Fatalf("want 2 emitted, got %v", ids)
	}
	c = newHistoryTestClient()
	c.handleTable(upsertTable(testThread, "mid.$a"))
	if msgs := drainMessages(c); len(msgs) != 1 || !msgs[0].IsHistory {
		t.Fatalf("upsert messages must carry IsHistory, got %+v", msgs)
	}
}

func TestHandleTableInsertIsNotHistory(t *testing.T) {
	c := newHistoryTestClient()
	c.handleTable(&table.LSTable{LSInsertMessage: []*table.LSInsertMessage{{ThreadKey: testThread, MessageId: "mid.$n", TimestampMs: 1000}}})
	if msgs := drainMessages(c); len(msgs) != 1 || msgs[0].IsHistory {
		t.Fatalf("insert messages must not be history, got %+v", msgs)
	}
}

func drainMessages(c *Client) []*Message {
	var out []*Message
	for {
		select {
		case e := <-c.eventChan:
			if m, ok := e.Data.(*Message); ok && e.Type == EventTypeMessage {
				out = append(out, m)
			}
		default:
			return out
		}
	}
}

func TestClassifyHistoryTaskError(t *testing.T) {
	live, cancelLive := context.WithCancel(context.Background())
	dead, cancelDead := context.WithCancel(context.Background())
	cancelDead()
	defer cancelLive()
	expired, cancelExp := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancelExp()
	<-expired.Done()
	boom := errors.New("boom")

	if err := classifyHistoryTaskError(dead, live, boom); err.Error() != "bridge disconnected" {
		t.Fatalf("got %v", err)
	}
	if err := classifyHistoryTaskError(live, expired, boom); err.Error() != "timed out waiting for Messenger history" {
		t.Fatalf("got %v", err)
	}
	if err := classifyHistoryTaskError(live, live, context.DeadlineExceeded); err.Error() != "timed out waiting for Messenger history" {
		t.Fatalf("got %v", err)
	}
	if err := classifyHistoryTaskError(live, live, boom); !errors.Is(err, boom) || !strings.HasPrefix(err.Error(), "fetch messages task: ") {
		t.Fatalf("got %v", err)
	}
}
