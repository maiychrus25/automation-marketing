package bridge

import (
	"context"
	"encoding/json"
	"testing"

	"go.mau.fi/libsignal/ecc"
	"go.mau.fi/libsignal/keys/identity"
	"go.mau.fi/libsignal/keys/prekey"
	"go.mau.fi/libsignal/protocol"
	"go.mau.fi/libsignal/session"
	"go.mau.fi/libsignal/util/optional"
	"go.mau.fi/whatsmeow/store"
	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"go.mau.fi/whatsmeow/util/keys"
)

// These tests drive the device store through libsignal the way whatsmeow does
// (session.NewBuilderFromSignal + session.NewCipher over store.Device), with no network.

var cryptoSerializer = store.SignalProtobufSerializer

func cryptoDevice(t *testing.T, user string, device uint16) *DeviceStore {
	t.Helper()
	ds, err := NewDeviceStoreMemoryOnly()
	if err != nil {
		t.Fatal(err)
	}
	ds.Device.ID = &waTypes.JID{User: user, Device: device, Server: waTypes.MessengerServer}
	return ds
}

func cryptoAddress(ds *DeviceStore) *protocol.SignalAddress {
	return ds.Device.ID.SignalAddress()
}

// bundleFor is what a sender gets from the server for `to`: identity, signed prekey and one one-time prekey.
func bundleFor(to *DeviceStore, oneTime *keys.PreKey) *prekey.Bundle {
	d := to.Device
	return prekey.NewBundle(d.RegistrationID, uint32(d.ID.Device),
		optional.NewOptionalUint32(oneTime.KeyID), d.SignedPreKey.KeyID,
		ecc.NewDjbECPublicKey(*oneTime.Pub), ecc.NewDjbECPublicKey(*d.SignedPreKey.Pub), *d.SignedPreKey.Signature,
		identity.NewKey(ecc.NewDjbECPublicKey(*d.IdentityKey.Pub)))
}

func cryptoEncrypt(t *testing.T, from, to *DeviceStore, bundle *prekey.Bundle, text string) protocol.CiphertextMessage {
	t.Helper()
	ctx := context.Background()
	builder := session.NewBuilderFromSignal(from.Device, cryptoAddress(to), cryptoSerializer)
	if bundle != nil {
		if err := builder.ProcessBundle(ctx, bundle); err != nil {
			t.Fatalf("process bundle: %v", err)
		}
	}
	msg, err := session.NewCipher(builder, cryptoAddress(to)).Encrypt(ctx, []byte(text))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	return msg
}

// cryptoDecrypt parses the wire bytes like whatsmeow's decryptDM does.
func cryptoDecrypt(to, from *DeviceStore, msg protocol.CiphertextMessage) (string, error) {
	ctx := context.Background()
	builder := session.NewBuilderFromSignal(to.Device, cryptoAddress(from), cryptoSerializer)
	cipher := session.NewCipher(builder, cryptoAddress(from))
	var plain []byte
	var err error
	if msg.Type() == protocol.PREKEY_TYPE {
		parsed, perr := protocol.NewPreKeySignalMessageFromBytes(msg.Serialize(), cryptoSerializer.PreKeySignalMessage, cryptoSerializer.SignalMessage)
		if perr != nil {
			return "", perr
		}
		plain, err = cipher.DecryptMessage(ctx, parsed)
	} else {
		parsed, perr := protocol.NewSignalMessageFromBytes(msg.Serialize(), cryptoSerializer.SignalMessage)
		if perr != nil {
			return "", perr
		}
		plain, err = cipher.Decrypt(ctx, parsed)
	}
	return string(plain), err
}

func mustDecrypt(t *testing.T, to, from *DeviceStore, msg protocol.CiphertextMessage, want string) {
	t.Helper()
	got, err := cryptoDecrypt(to, from, msg)
	if err != nil {
		t.Fatalf("decrypt %q: %v", want, err)
	}
	if got != want {
		t.Fatalf("decrypt: got %q want %q", got, want)
	}
}

func restoreDevice(t *testing.T, ds *DeviceStore) *DeviceStore {
	t.Helper()
	data, err := ds.GetDeviceData()
	if err != nil {
		t.Fatal(err)
	}
	restored, err := NewDeviceStoreFromData(data)
	if err != nil {
		t.Fatal(err)
	}
	return restored
}

func TestRestoredDeviceStillDecryptsFromKnownAndNewSenders(t *testing.T) {
	ctx := context.Background()
	app := cryptoDevice(t, "100", 7)             // MaiHub's device
	phone := cryptoDevice(t, "200", 3)           // a peer device with a session before the restart
	uploaded, err := app.GetOrGenPreKeys(ctx, 5) // one-time prekeys the server hands out
	if err != nil {
		t.Fatal(err)
	}

	mustDecrypt(t, app, phone, cryptoEncrypt(t, phone, app, bundleFor(app, uploaded[0]), "before-1"), "before-1")
	// A reply moves the session past the prekey stage, as in a real conversation.
	mustDecrypt(t, phone, app, cryptoEncrypt(t, app, phone, nil, "reply-1"), "reply-1")
	mustDecrypt(t, app, phone, cryptoEncrypt(t, phone, app, nil, "before-2"), "before-2")

	app = restoreDevice(t, app) // app restart

	// Existing session keeps working in both directions.
	mustDecrypt(t, app, phone, cryptoEncrypt(t, phone, app, nil, "after-1"), "after-1")
	mustDecrypt(t, phone, app, cryptoEncrypt(t, app, phone, nil, "reply-2"), "reply-2")
	mustDecrypt(t, app, phone, cryptoEncrypt(t, phone, app, nil, "after-2"), "after-2")

	// A device that never talked to us uses a one-time prekey uploaded before the restart.
	tablet := cryptoDevice(t, "200", 9)
	mustDecrypt(t, app, tablet, cryptoEncrypt(t, tablet, app, bundleFor(app, uploaded[1]), "new-sender"), "new-sender")

	// Retry path: a fresh one-time prekey generated after the restart.
	fresh, err := app.GenOnePreKey(ctx)
	if err != nil {
		t.Fatal(err)
	}
	laptop := cryptoDevice(t, "300", 2)
	mustDecrypt(t, app, laptop, cryptoEncrypt(t, laptop, app, bundleFor(app, fresh), "retry-sender"), "retry-sender")

	// And once more across a second restart.
	app = restoreDevice(t, app)
	mustDecrypt(t, app, tablet, cryptoEncrypt(t, tablet, app, nil, "after-second-restart"), "after-second-restart")
}

// The 26.37.0 failure: the bridge died between uploading one-time prekeys and the parent storing the
// snapshot that held them. Facebook kept handing those prekeys to senders; the restored device no
// longer had them, so nothing sent to it could be decrypted.
func TestPreKeysUploadedBeforeALostSnapshotStillDecrypt(t *testing.T) {
	ctx := context.Background()
	app := cryptoDevice(t, "100", 7)
	registered, err := app.GetDeviceData() // stored right after registration, before the first upload
	if err != nil {
		t.Fatal(err)
	}
	uploaded, err := app.GetOrGenPreKeys(ctx, 812) // the server holds these; the snapshot with them is lost
	if err != nil {
		t.Fatal(err)
	}

	restored, err := NewDeviceStoreFromData(registered)
	if err != nil {
		t.Fatal(err)
	}
	phone := cryptoDevice(t, "200", 3)
	mustDecrypt(t, restored, phone, cryptoEncrypt(t, phone, restored, bundleFor(restored, uploaded[5]), "queued"), "queued")

	// Uploading again after the loss must publish the same keys for the same ids, not different ones.
	again, err := restored.GetOrGenPreKeys(ctx, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, pk := range again {
		if pk.KeyID == uploaded[5].KeyID {
			t.Fatalf("id %d was consumed above and must not be published again", pk.KeyID)
		}
		if original := uploaded[pk.KeyID-1]; original.KeyID != pk.KeyID || *pk.Pub != *original.Pub {
			t.Fatalf("prekey id %d differs after the lost snapshot", pk.KeyID)
		}
	}
}

func TestUsedOneTimePreKeyIsNotServedAgain(t *testing.T) {
	ctx := context.Background()
	app := cryptoDevice(t, "100", 7)
	uploaded, _ := app.GetOrGenPreKeys(ctx, 5)
	phone := cryptoDevice(t, "200", 3)
	mustDecrypt(t, app, phone, cryptoEncrypt(t, phone, app, bundleFor(app, uploaded[2]), "first"), "first")

	if pk, _ := app.GetPreKey(ctx, uploaded[2].KeyID); pk != nil {
		t.Fatal("a consumed one-time prekey must not be served again")
	}
	if pk, _ := app.GetPreKey(ctx, uploaded[3].KeyID); pk == nil {
		t.Fatal("an unused one-time prekey must still be available")
	}
	app = restoreDevice(t, app)
	if pk, _ := app.GetPreKey(ctx, uploaded[2].KeyID); pk != nil {
		t.Fatal("a consumed one-time prekey must stay consumed after a restart")
	}
	if pk, _ := app.GetPreKey(ctx, 0); pk != nil {
		t.Fatal("prekey id 0 is never valid")
	}
}

func TestSnapshotStaysSmallAfterInitialUpload(t *testing.T) {
	app := cryptoDevice(t, "100", 7)
	if _, err := app.GetOrGenPreKeys(context.Background(), 812); err != nil {
		t.Fatal(err)
	}
	data, _ := app.GetDeviceData()
	if len(data) > 4096 {
		t.Fatalf("snapshot must not carry the uploaded prekeys, got %d bytes", len(data))
	}
	if n, _ := app.UploadedPreKeyCount(context.Background()); n < 5 {
		t.Fatalf("after an upload the store must report enough prekeys, got %d", n)
	}
	fresh := cryptoDevice(t, "100", 8)
	if n, _ := fresh.UploadedPreKeyCount(context.Background()); n != 0 {
		t.Fatalf("a device that never uploaded must report 0, got %d", n)
	}
}

func TestStoredDeviceWithoutPreKeySeedIsNotRestored(t *testing.T) {
	app := cryptoDevice(t, "100", 7)
	data, _ := app.GetDeviceData()
	var fields map[string]any
	if err := json.Unmarshal([]byte(data), &fields); err != nil {
		t.Fatal(err)
	}
	delete(fields, "pre_key_seed") // what 26.37.0 stored
	legacy, _ := json.Marshal(fields)

	if _, err := NewDeviceStoreFromData(string(legacy)); err == nil {
		t.Fatal("a stored device without a prekey seed must be rejected")
	}
	c, err := NewClient(&ClientConfig{Cookies: map[string]string{}, DeviceData: string(legacy), LogLevel: "none"})
	if err != nil {
		t.Fatal(err)
	}
	if !needsE2EERegistration(c.DeviceStore.Device) || c.deviceRestored {
		t.Fatal("expected a fresh, unregistered device")
	}
	c2, err := NewClient(&ClientConfig{Cookies: map[string]string{}, DeviceData: data, LogLevel: "none"})
	if err != nil {
		t.Fatal(err)
	}
	if needsE2EERegistration(c2.DeviceStore.Device) || !c2.deviceRestored {
		t.Fatal("a stored device with a seed must be restored")
	}
}

func drainDeviceResets(c *Client) int {
	n := 0
	for {
		select {
		case e := <-c.eventChan:
			if data, ok := e.Data.(map[string]any); ok && e.Type == EventTypeDisconnected && data["loggedOut"] == true {
				n++
			}
		default:
			return n
		}
	}
}

func TestRepeatedUndecryptableMessagesResetARestoredDeviceOnce(t *testing.T) {
	app := cryptoDevice(t, "100", 7)
	data, _ := app.GetDeviceData()
	c, err := NewClient(&ClientConfig{Cookies: map[string]string{}, DeviceData: data, LogLevel: "none"})
	if err != nil {
		t.Fatal(err)
	}
	failed := &events.UndecryptableMessage{}
	for i := 0; i < undecryptableResetThreshold-1; i++ {
		c.handleE2EEEvent(failed)
	}
	if n := drainDeviceResets(c); n != 0 {
		t.Fatalf("no reset below the threshold, got %d", n)
	}
	c.noteDecrypted() // a message that decrypts ends the streak
	for i := 0; i < undecryptableResetThreshold-1; i++ {
		c.handleE2EEEvent(failed)
	}
	c.handleE2EEEvent(&events.UndecryptableMessage{IsUnavailable: true}) // placeholder, not a failed decrypt
	if n := drainDeviceResets(c); n != 0 {
		t.Fatalf("streak must restart after a good message and ignore unavailable placeholders, got %d", n)
	}
	c.handleE2EEEvent(failed)
	c.handleE2EEEvent(failed)
	if n := drainDeviceResets(c); n != 1 {
		t.Fatalf("want exactly one reset request, got %d", n)
	}
	var snapshots int
	c.DeviceStore.setOnDataChanged(func(string) { snapshots++ })
	c.DeviceStore.Save()
	if snapshots != 0 {
		t.Fatal("a device being reset must stop publishing snapshots")
	}

	fresh, _ := NewClient(&ClientConfig{Cookies: map[string]string{}, LogLevel: "none"})
	for i := 0; i < undecryptableResetThreshold*3; i++ {
		fresh.handleE2EEEvent(failed)
	}
	if n := drainDeviceResets(fresh); n != 0 {
		t.Fatalf("a device registered in this run is never reset for decrypt failures, got %d", n)
	}
}

func TestConsumedIdIsSkippedWhenUploadingAgain(t *testing.T) {
	ctx := context.Background()
	app := cryptoDevice(t, "100", 7)
	first, _ := app.GetOrGenPreKeys(ctx, 3) // ids 1..3
	phone := cryptoDevice(t, "200", 3)
	mustDecrypt(t, app, phone, cryptoEncrypt(t, phone, app, bundleFor(app, first[1]), "uses-2"), "uses-2")

	// The consumed id is remembered, but the counter is rolled back as if its snapshot was lost.
	app.mu.Lock()
	app.nextPreKeyID = 1
	app.mu.Unlock()
	again, _ := app.GetOrGenPreKeys(ctx, 3)
	got := []uint32{again[0].KeyID, again[1].KeyID, again[2].KeyID}
	if got[0] != 1 || got[1] != 3 || got[2] != 4 {
		t.Fatalf("consumed id 2 must be skipped, got %v", got)
	}
}
