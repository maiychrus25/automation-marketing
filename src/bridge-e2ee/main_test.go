package main

import (
	"encoding/json"
	"testing"
	"time"
)

func parse(t *testing.T, raw string) (int64, int64, string, time.Duration, error) {
	t.Helper()
	return parseFetchMessagesParams(json.RawMessage(raw))
}

func TestParseFetchMessagesParams(t *testing.T) {
	t.Run("string id", func(t *testing.T) {
		id, ts, before, timeout, err := parse(t, `{"threadId":"123456","beforeTimestampMs":1700000000000,"beforeMessageId":"mid.$a","timeoutMs":25000}`)
		if err != nil || id != 123456 || ts != 1700000000000 || before != "mid.$a" || timeout != 25*time.Second {
			t.Fatalf("got %d %d %q %v %v", id, ts, before, timeout, err)
		}
	})
	t.Run("suffix stripped", func(t *testing.T) {
		id, _, _, _, err := parse(t, `{"threadId":"123456@msgr"}`)
		if err != nil || id != 123456 {
			t.Fatalf("got %d %v", id, err)
		}
	})
	t.Run("17 digit id exact", func(t *testing.T) {
		id, _, _, _, err := parse(t, `{"threadId":"24512345678901234"}`)
		if err != nil || id != 24512345678901234 {
			t.Fatalf("got %d %v", id, err)
		}
	})
	t.Run("number id rejected", func(t *testing.T) {
		if _, _, _, _, err := parse(t, `{"threadId":123456}`); err == nil {
			t.Fatal("expected error for a JSON number threadId")
		}
	})
	t.Run("empty or zero id", func(t *testing.T) {
		for _, raw := range []string{`{"threadId":"0"}`, `{"threadId":"abc"}`, `{"threadId":"@x"}`} {
			_, _, _, _, err := parse(t, raw)
			if err == nil || err.Error() != `invalid threadId "`+map[string]string{`{"threadId":"0"}`: "0", `{"threadId":"abc"}`: "abc", `{"threadId":"@x"}`: "@x"}[raw]+`"` {
				t.Fatalf("%s: got %v", raw, err)
			}
		}
		if _, _, _, _, err := parse(t, `{"threadId":""}`); err == nil || err.Error() != "threadId is required" {
			t.Fatalf("empty: got %v", err)
		}
	})
	t.Run("timeout default and clamp", func(t *testing.T) {
		_, _, _, timeout, _ := parse(t, `{"threadId":"1","timeoutMs":0}`)
		if timeout != 0 {
			t.Fatalf("0 should keep the bridge default (0), got %v", timeout)
		}
		_, _, _, timeout, _ = parse(t, `{"threadId":"1","timeoutMs":999999}`)
		if timeout != 60*time.Second {
			t.Fatalf("expected 60s clamp, got %v", timeout)
		}
	})
}
