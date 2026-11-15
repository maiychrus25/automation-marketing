package bridge

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	waTypes "go.mau.fi/whatsmeow/types"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func TestNeedsE2EERegistration(t *testing.T) {
	fresh, _ := NewDeviceStoreMemoryOnly()
	if !needsE2EERegistration(fresh.Device) {
		t.Fatal("a fresh device must register")
	}
	fresh.Device.ID = &waTypes.JID{User: "100", Device: 7, Server: waTypes.MessengerServer}
	if needsE2EERegistration(fresh.Device) {
		t.Fatal("a device with a server identity must not register again")
	}
	fresh.Device.ID.Device = 0
	if !needsE2EERegistration(fresh.Device) {
		t.Fatal("device id 0 is not registered")
	}
	fresh.Device.ID.Device = 7
	fresh.Device.ID.User = ""
	if !needsE2EERegistration(fresh.Device) {
		t.Fatal("empty user is not registered")
	}
	if !needsE2EERegistration(nil) {
		t.Fatal("nil device must register")
	}
}

func TestDeviceDataRoundTripKeepsIdentityAndSessions(t *testing.T) {
	ctx := context.Background()
	a, _ := NewDeviceStoreMemoryOnly()
	a.Device.ID = &waTypes.JID{User: "100", Device: 7, Server: waTypes.MessengerServer}
	if err := a.PutSession(ctx, "peer.1", []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	data, err := a.GetDeviceData()
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewDeviceStoreFromData(data)
	if err != nil {
		t.Fatal(err)
	}
	if *a.Device.NoiseKey.Priv != *b.Device.NoiseKey.Priv || *a.Device.IdentityKey.Priv != *b.Device.IdentityKey.Priv {
		t.Fatal("keys changed across the round trip")
	}
	if a.Device.RegistrationID != b.Device.RegistrationID {
		t.Fatal("registration id changed")
	}
	if b.Device.ID == nil || b.Device.ID.User != "100" || b.Device.ID.Device != 7 {
		t.Fatalf("identity lost: %v", b.Device.ID)
	}
	if needsE2EERegistration(b.Device) {
		t.Fatal("restored device must not register again")
	}
	got, _ := b.GetSession(ctx, "peer.1")
	if !bytes.Equal(got, []byte{1, 2, 3}) {
		t.Fatalf("session lost: %v", got)
	}
}

func TestSavePublishesSnapshotAndStopsAfterDeleteDevice(t *testing.T) {
	ds, _ := NewDeviceStoreMemoryOnly()
	var got []string
	ds.setOnDataChanged(func(s string) { got = append(got, s) })
	if err := ds.Save(); err != nil || len(got) != 1 {
		t.Fatalf("want one snapshot, got %d (%v)", len(got), err)
	}
	if err := ds.DeleteDevice(context.Background(), ds.Device); err != nil {
		t.Fatal(err)
	}
	if err := ds.Save(); err != nil || len(got) != 1 {
		t.Fatalf("Save after DeleteDevice must publish nothing, got %d (%v)", len(got), err)
	}
}

func TestNewClientFallsBackToNewDeviceOnBadDeviceData(t *testing.T) {
	c, err := NewClient(&ClientConfig{Cookies: map[string]string{}, DeviceData: "{not json", LogLevel: "none"})
	if err != nil {
		t.Fatal(err)
	}
	if c.DeviceStore.Device == nil || !needsE2EERegistration(c.DeviceStore.Device) {
		t.Fatal("expected a fresh unregistered device")
	}
}

func TestNewClientPublishesSnapshotsWithoutDevicePath(t *testing.T) {
	dir := t.TempDir()
	prev, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(prev)

	c, err := NewClient(&ClientConfig{Cookies: map[string]string{}, LogLevel: "none"})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.DeviceStore.Save(); err != nil {
		t.Fatal(err)
	}
	select {
	case evt := <-c.Events():
		data, _ := evt.Data.(map[string]interface{})
		if evt.Type != EventDeviceDataChanged || data["deviceData"] == "" || data["deviceData"] == nil {
			t.Fatalf("unexpected event %v", evt.Type)
		}
	default:
		t.Fatal("no deviceDataChanged event")
	}
	if _, err := os.Stat(dir + "/e2ee_device.json"); err == nil {
		t.Fatal("e2ee_device.json must not be created")
	}

	m, err := NewClient(&ClientConfig{Cookies: map[string]string{}, LogLevel: "none", E2EEMemoryOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	m.DeviceStore.Save()
	select {
	case evt := <-m.Events():
		t.Fatalf("memory-only mode must emit nothing, got %v", evt.Type)
	default:
	}
}

func TestSaveSoonCoalescesBurstIntoOneSnapshot(t *testing.T) {
	prev := deviceSnapshotDelay
	deviceSnapshotDelay = 20 * time.Millisecond
	defer func() { deviceSnapshotDelay = prev }()

	ctx := context.Background()
	ds, _ := NewDeviceStoreMemoryOnly()
	got := make(chan string, 64)
	ds.setOnDataChanged(func(s string) { got <- s })
	for i := 0; i < 50; i++ {
		if err := ds.PutSession(ctx, "peer."+strconv.Itoa(i), []byte{byte(i)}); err != nil {
			t.Fatal(err)
		}
	}
	var last string
	select {
	case last = <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("no snapshot after a burst of writes")
	}
	time.Sleep(4 * deviceSnapshotDelay)
	if extra := len(got); extra != 0 {
		t.Fatalf("burst must publish one snapshot, got %d more", extra)
	}
	restored, err := NewDeviceStoreFromData(last)
	if err != nil {
		t.Fatal(err)
	}
	if s, _ := restored.GetSession(ctx, "peer.49"); !bytes.Equal(s, []byte{49}) {
		t.Fatal("the snapshot must contain the last write of the burst")
	}

	// A later write is published too (the queue flag is released).
	ds.PutSession(ctx, "peer.late", []byte{7})
	select {
	case <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("a write after the burst was not published")
	}
}

type countingLog struct{ warn, info, debug int }

func (l *countingLog) Warnf(string, ...any)    { l.warn++ }
func (l *countingLog) Errorf(string, ...any)   {}
func (l *countingLog) Infof(string, ...any)    { l.info++ }
func (l *countingLog) Debugf(string, ...any)   { l.debug++ }
func (l *countingLog) Sub(string) waLog.Logger { return l }

// The release build runs the bridge at error level, which hid why an E2EE message could not be
// decrypted. Those lines must reach stderr at any level; everything else keeps the configured level.
func TestDiagLogWritesDecryptFailuresAndForwardsTheRest(t *testing.T) {
	var out bytes.Buffer
	inner := &countingLog{}
	log := diagLog{Logger: inner, out: &out}

	log.Warnf("Error decrypting message %s from %s: %v", "m1", "100:96@msgr", errors.New("bad MAC"))
	log.Debugf("Database has %d prekeys, server says we have %d", 0, 812)
	log.Infof("Uploading %d new prekeys to server", 812)
	log.Sub("Recv").Warnf("Not sending any more retry receipts for %s", "m1")
	for _, want := range []string{"bad MAC", "server says we have 812", "Uploading 812", "retry receipts for m1"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("diagnostic line %q missing from %q", want, out.String())
		}
	}
	if inner.warn+inner.info+inner.debug != 0 {
		t.Fatal("a diagnostic line must be written once, not forwarded as well")
	}

	out.Reset()
	log.Warnf("Unhandled encrypted message (type %s) from %s", "x", "y")
	log.Debugf("Decrypting message from %s", "y")
	log.Infof("Updated LID to %s", "z")
	if out.Len() != 0 {
		t.Fatalf("only decrypt diagnostics bypass the level, got %q", out.String())
	}
	if inner.warn != 1 || inner.debug != 1 || inner.info != 1 {
		t.Fatalf("other lines go to the wrapped logger, got %+v", *inner)
	}
}

// libsignal prints its warnings and errors to stdout when no logger is set, which is the bridge's
// JSON-RPC channel. They name the step of a decrypt that failed; its debug lines dump session state.
func TestSignalDiagKeepsFailureReasonsAndDropsStateDumps(t *testing.T) {
	var out bytes.Buffer
	log := signalDiag{out: &out}
	log.Error("SessionCipher.go:319", "Unable to verify ciphertext mac: mismatching MAC in signal message")
	log.Warning("SessionCipher.go:263", "failed to verify ciphertext MAC: mismatching MAC in signal message")
	log.Debug("Session.go:112", "Processing message with PreKeyID: &{51 false}")
	log.Debug("Session.go:119", "We've already setup a session for this V3 message, letting bundled message fall through...")
	for _, want := range []string{"ERR [libsignal] SessionCipher.go:319 Unable to verify ciphertext mac", "WRN [libsignal]", "PreKeyID: &{51 false}", "already setup a session"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("line %q missing from %q", want, out.String())
		}
	}
	out.Reset()
	log.Debug("SessionCipher.go:291", "Decrypting ciphertext with session state: SECRET")
	log.Debug("SessionCipher.go:400", "Using cipherKey: SECRET")
	log.Info("x.go:1", "anything")
	if out.Len() != 0 {
		t.Fatalf("state dumps must not be written, got %q", out.String())
	}
}

// The store traces which session bytes it was given and which it hands back, so a reply that cannot be
// decrypted can be matched against the session it should belong to. The trace is a short hash, never the bytes.
func TestStoreDiagTracesSessionsAndPrekeysWithoutTheirContent(t *testing.T) {
	ctx := context.Background()
	ds, _ := NewDeviceStoreMemoryOnly()
	if err := ds.PutSession(ctx, "100:96", []byte("no-trace-yet")); err != nil { // nil diagOut: no trace, no panic
		t.Fatal(err)
	}
	var out bytes.Buffer
	ds.diagOut = &out
	secret := []byte("SESSION-SECRET-BYTES")
	ds.PutManySessions(ctx, map[string][]byte{"100:96": secret})
	ds.GetSession(ctx, "100:96")
	ds.GetSession(ctx, "100:97")
	one, _ := ds.GenOnePreKey(ctx)
	ds.GetPreKey(ctx, one.KeyID)
	ds.GetOrGenPreKeys(ctx, 3)
	got := out.String()
	if strings.Contains(got, string(secret)) {
		t.Fatal("session bytes leaked into the trace")
	}
	lines := strings.Split(strings.TrimSpace(got), "\n")
	if len(lines) != 6 {
		t.Fatalf("want 6 trace lines, got %d: %q", len(lines), got)
	}
	putTag := lines[0][strings.Index(lines[0], "len="):]
	if !strings.Contains(lines[0], "session put addr=100:96") || !strings.HasSuffix(lines[1], putTag) || !strings.Contains(lines[1], "session get addr=100:96") {
		t.Fatalf("put and get of the same session must carry the same tag: %q / %q", lines[0], lines[1])
	}
	for i, want := range []string{"", "", "session get addr=100:97 none", "prekey issued id=1", "prekey lookup id=1 next=2 used=false", "prekeys issued ids=2..4"} {
		if want != "" && !strings.Contains(lines[i], want) {
			t.Fatalf("line %d: want %q in %q", i, want, lines[i])
		}
	}
}
