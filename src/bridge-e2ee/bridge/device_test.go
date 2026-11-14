package bridge

import (
	"bytes"
	"context"
	"os"
	"strconv"
	"testing"
	"time"

	waTypes "go.mau.fi/whatsmeow/types"
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
