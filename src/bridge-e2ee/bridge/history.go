package bridge

// Ported from babyvibe/deplao-builder @2162f07 (MIT), adapted to this Client.
//
// Lịch sử Messenger theo từng hội thoại: web tải tin cũ bằng LightSpeed
// FetchMessagesTask, neo theo (timestamp, message id). Câu trả lời đến sau
// trong luồng sự kiện dưới dạng upsert có range (LSUpsertMessage +
// LSInsertNewMessageRange) hoặc LSUpdateExistingMessageRange khi hết tin.
// Mỗi lệnh trả đúng một trang để app dừng đúng mốc và lưu từng trang.

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	"go.mau.fi/mautrix-meta/pkg/messagix/socket"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

// HistoryPage is one page of a thread's history, newest first.
type HistoryPage struct {
	ThreadID       string     `json:"threadId"`
	Messages       []*Message `json:"messages"`
	HasMoreBefore  bool       `json:"hasMoreBefore"`
	MinTimestampMs int64      `json:"minTimestampMs"`
	MinMessageID   string     `json:"minMessageId,omitempty"`
}

// historyGraceWindow: after a request ends, a late answer for the thread is
// still treated as history (never emitted as live messages).
const historyGraceWindow = 60 * time.Second

type historyCollector struct {
	mu       sync.Mutex
	messages []*Message
	seen     map[string]bool
	rangeSet bool
	hasMore  bool
	minTs    int64
	minID    string
	// referenceTs is the ReferenceTimestampMs of the request; an "existing
	// range" answer carries it back and answers for other anchors are ignored.
	referenceTs int64
	hasRefID    bool
	endedBy     string
	done        chan struct{}
	once        sync.Once
}

func (h *historyCollector) finish() {
	h.once.Do(func() { close(h.done) })
}

func (c *Client) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

// historyClaimed reports whether a thread has a waiting collector or an
// unexpired tombstone; expired tombstones are pruned here.
func (c *Client) historyClaimed(threadID int64) bool {
	c.historyMu.Lock()
	defer c.historyMu.Unlock()
	if c.historyCollectors[threadID] != nil {
		return true
	}
	expiry, ok := c.historyTombstones[threadID]
	if ok && !c.clock().Before(expiry) {
		delete(c.historyTombstones, threadID)
		return false
	}
	return ok
}

func (c *Client) historyCollector(threadID int64) *historyCollector {
	c.historyMu.Lock()
	defer c.historyMu.Unlock()
	return c.historyCollectors[threadID]
}

// registerHistoryCollector claims the thread for one history request. The
// returned func releases it and must always be called.
func (c *Client) registerHistoryCollector(threadID, beforeTs int64) (*historyCollector, func(), error) {
	collector := &historyCollector{seen: map[string]bool{}, done: make(chan struct{}), referenceTs: beforeTs}
	c.historyMu.Lock()
	defer c.historyMu.Unlock()
	if c.historyCollectors == nil {
		c.historyCollectors = map[int64]*historyCollector{}
	}
	if _, busy := c.historyCollectors[threadID]; busy {
		return nil, nil, fmt.Errorf("history request already running for thread %d", threadID)
	}
	c.historyCollectors[threadID] = collector
	delete(c.historyTombstones, threadID) // a new request takes over
	release := func() {
		c.historyMu.Lock()
		defer c.historyMu.Unlock()
		if c.historyCollectors[threadID] == collector {
			delete(c.historyCollectors, threadID)
			if c.historyTombstones == nil {
				c.historyTombstones = map[int64]time.Time{}
			}
			c.historyTombstones[threadID] = c.clock().Add(historyGraceWindow)
		}
	}
	return collector, release, nil
}

// deliverHistory feeds range-backed upserts and existing-range answers to the
// waiting collectors. It returns the thread keys whose upserts were consumed
// and must not be emitted as live messages.
func (c *Client) deliverHistory(tbl *table.LSTable, upsert map[int64]*table.UpsertMessages) map[int64]bool {
	claimed := map[int64]bool{}
	if tbl == nil {
		return claimed
	}
	for threadID, batch := range upsert {
		collector := c.historyCollector(threadID)
		if collector == nil {
			// Late answer of a finished request: claim it without collecting.
			if batch != nil && c.historyClaimed(threadID) {
				claimed[threadID] = true
			}
			continue
		}
		if batch == nil {
			continue
		}
		claimed[threadID] = true
		collector.mu.Lock()
		for _, wrapped := range batch.Messages {
			if wrapped == nil || wrapped.MessageId == "" || collector.seen[wrapped.MessageId] {
				continue
			}
			collector.seen[wrapped.MessageId] = true
			collector.messages = append(collector.messages, c.convertWrappedMessage(wrapped))
		}
		if batch.Range != nil {
			collector.rangeSet = true
			collector.hasMore = batch.Range.HasMoreBefore
			collector.minTs = batch.Range.MinTimestampMs
			collector.minID = batch.Range.MinMessageId
		}
		if collector.endedBy == "" {
			collector.endedBy = "range"
		}
		collector.mu.Unlock()
		collector.finish()
	}
	for _, rng := range tbl.LSUpdateExistingMessageRange {
		if rng == nil {
			continue
		}
		collector := c.historyCollector(rng.ThreadKey)
		if collector == nil {
			continue
		}
		collector.mu.Lock()
		if collector.referenceTs != 0 && rng.TimestampMS != 0 && rng.TimestampMS != collector.referenceTs {
			// Not the answer to this request (same rule as mautrix-meta): keep waiting.
			collector.mu.Unlock()
			continue
		}
		if len(collector.messages) == 0 {
			// Nothing older than the anchor: the start of the chat is reached.
			collector.rangeSet = true
			collector.hasMore = false
		}
		if collector.endedBy == "" {
			collector.endedBy = "existing_range"
		}
		collector.mu.Unlock()
		collector.finish()
	}
	return claimed
}

// awaitHistoryPage waits for the collector to complete, ctx to expire, or the
// bridge to disconnect, then builds the page.
func (c *Client) awaitHistoryPage(ctx context.Context, collector *historyCollector, threadID int64) (*HistoryPage, error) {
	select {
	case <-collector.done:
	case <-ctx.Done():
		c.Logger.Warn().Int64("thread", threadID).Int64("reference_ts", collector.referenceTs).
			Msg("History: timed out waiting for Messenger history")
		return nil, errors.New("timed out waiting for Messenger history")
	case <-c.ctx.Done():
		return nil, errors.New("bridge disconnected")
	}

	collector.mu.Lock()
	defer collector.mu.Unlock()
	c.Logger.Info().Int64("thread", threadID).Int64("reference_ts", collector.referenceTs).Bool("reference_id", collector.hasRefID).
		Int("messages", len(collector.messages)).Bool("range", collector.rangeSet).Bool("has_more_before", collector.hasMore).
		Str("ended_by", collector.endedBy).Msg("History page")
	page := &HistoryPage{
		ThreadID:       strconv.FormatInt(threadID, 10),
		Messages:       append([]*Message{}, collector.messages...),
		HasMoreBefore:  collector.hasMore,
		MinTimestampMs: collector.minTs,
		MinMessageID:   collector.minID,
	}
	sort.SliceStable(page.Messages, func(i, j int) bool { return page.Messages[i].TimestampMs > page.Messages[j].TimestampMs })
	if !collector.rangeSet && len(page.Messages) > 0 {
		oldest := page.Messages[len(page.Messages)-1]
		page.MinTimestampMs, page.MinMessageID, page.HasMoreBefore = oldest.TimestampMs, oldest.ID, true
	}
	return page, nil
}

// FetchThreadHistory returns one page of messages older than (beforeTs,
// beforeID). beforeTs <= 0 means "now" (the newest page).
func (c *Client) FetchThreadHistory(ctx context.Context, threadID, beforeTs int64, beforeID string, timeout time.Duration) (*HistoryPage, error) {
	if threadID == 0 {
		return nil, errors.New("threadId is required")
	}
	if c.Messagix == nil {
		return nil, errors.New("Messenger client is not initialised")
	}
	if beforeTs <= 0 {
		beforeTs = time.Now().UnixMilli()
	}
	if timeout <= 0 {
		timeout = 25 * time.Second
	}

	collector, release, err := c.registerHistoryCollector(threadID, beforeTs)
	if err != nil {
		return nil, err
	}
	defer release()
	collector.mu.Lock()
	collector.hasRefID = beforeID != ""
	collector.mu.Unlock()

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	resp, err := c.Messagix.ExecuteTasks(reqCtx, &socket.FetchMessagesTask{
		ThreadKey:            threadID,
		Direction:            0,
		ReferenceTimestampMs: beforeTs,
		ReferenceMessageId:   beforeID,
		SyncGroup:            1,
		Cursor:               c.Messagix.GetCursor(1),
	})
	if err != nil {
		return nil, classifyHistoryTaskError(c.ctx, reqCtx, err)
	}
	if resp != nil {
		upsert, _ := resp.WrapMessages()
		c.deliverHistory(resp, upsert)
	}
	return c.awaitHistoryPage(reqCtx, collector, threadID)
}

// classifyHistoryTaskError maps a failed task send to the error strings the
// app matches on.
func classifyHistoryTaskError(clientCtx, reqCtx context.Context, err error) error {
	switch {
	case clientCtx.Err() != nil:
		return errors.New("bridge disconnected")
	case errors.Is(err, context.DeadlineExceeded) || reqCtx.Err() == context.DeadlineExceeded:
		return errors.New("timed out waiting for Messenger history")
	}
	return fmt.Errorf("fetch messages task: %w", err)
}
