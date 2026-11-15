package bridge

import (
	"context"
	"crypto/hmac"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"time"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"go.mau.fi/libsignal/keys/prekey"
	signallog "go.mau.fi/libsignal/logger"
	"go.mau.fi/util/exhttp"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/store"
	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/util/keys"
	waLog "go.mau.fi/whatsmeow/util/log"

	"go.mau.fi/mautrix-meta/pkg/messagix"
	"go.mau.fi/mautrix-meta/pkg/messagix/cookies"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
	"go.mau.fi/mautrix-meta/pkg/messagix/types"
)

// Client wraps the messagix client and e2ee client
type Client struct {
	ID          uint64
	Messagix    *messagix.Client
	E2EE        *whatsmeow.Client
	DeviceStore *DeviceStore
	Logger      zerolog.Logger
	FBID        int64
	Platform    types.Platform

	eventChan           chan *Event
	ctx                 context.Context
	cancel              context.CancelFunc
	mu                  sync.RWMutex
	threadCache         map[int64]*Thread
	recentUnreactions   map[string]int64 // key: messageId+actorId, value: timestamp
	recentUnreactionsMu sync.RWMutex

	// historyCollectors: one waiting history request per thread (history.go).
	historyMu         sync.Mutex
	historyCollectors map[int64]*historyCollector
	// historyTombstones: thread -> expiry; late answers of a released request stay claimed.
	historyTombstones map[int64]time.Time
	now               func() time.Time // nil means time.Now (tests inject a clock)

	// deviceRestored: the E2EE device came from stored state instead of being registered in this run.
	deviceRestored bool
	// diagOut receives the E2EE diagnostic lines (diagLog); nil when logging is disabled.
	diagOut io.Writer
}

// ClientConfig for creating a new client
type ClientConfig struct {
	Cookies        map[string]string `json:"cookies"`
	Platform       string            `json:"platform"` // "facebook", "messenger", "instagram"
	DevicePath     string            `json:"devicePath"`
	DeviceData     string            `json:"deviceData,omitempty"`     // JSON string of device data (optional, takes priority over DevicePath)
	E2EEMemoryOnly bool              `json:"e2eeMemoryOnly,omitempty"` // If true, E2EE state is stored in memory only (no file, no events)
	LogLevel       string            `json:"logLevel"`
}

// NewClient creates a new messagix client
func NewClient(cfg *ClientConfig) (*Client, error) {
	// Parse platform
	var platform types.Platform
	switch cfg.Platform {
	case "facebook":
		platform = types.Facebook
	case "messenger":
		platform = types.Messenger
	case "instagram":
		platform = types.Instagram
	default:
		platform = types.Facebook
	}

	// Create cookies
	cks := &cookies.Cookies{Platform: platform}
	valMap := make(map[cookies.MetaCookieName]string)
	for k, v := range cfg.Cookies {
		valMap[cookies.MetaCookieName(k)] = v
	}
	cks.UpdateValues(valMap)

	// Setup logger
	logLevel := zerolog.InfoLevel
	switch cfg.LogLevel {
	case "debug":
		logLevel = zerolog.DebugLevel
	case "trace":
		logLevel = zerolog.TraceLevel
	case "warn":
		logLevel = zerolog.WarnLevel
	case "error":
		logLevel = zerolog.ErrorLevel
	case "none":
		logLevel = zerolog.Disabled
	}
	zerolog.SetGlobalLevel(logLevel)
	logger := zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr}).With().Timestamp().Logger()

	// Create messagix client
	msgClient := messagix.NewClient(cks, logger, &messagix.Config{
		ClientSettings: exhttp.ClientSettings{},
	})

	// Create device store. Priority: memory-only, stored deviceData, in-memory (no path), file.
	var deviceStore *DeviceStore
	var err error
	deviceRestored := false
	switch {
	case cfg.E2EEMemoryOnly:
		deviceStore, err = NewDeviceStoreMemoryOnly()
	case cfg.DeviceData != "":
		deviceStore, err = NewDeviceStoreFromData(cfg.DeviceData)
		if err != nil {
			// Never log err or the data: they belong to a private-key blob.
			logger.Warn().Msg("Stored E2EE device is unusable, creating a new one")
			deviceStore, err = NewDeviceStoreMemoryOnly()
		} else {
			deviceRestored = true
		}
	case cfg.DevicePath == "":
		deviceStore, err = NewDeviceStoreMemoryOnly()
	default:
		deviceStore, err = NewDeviceStore(cfg.DevicePath)
	}
	if err != nil {
		return nil, err
	}

	// Set device on client
	msgClient.SetDevice(deviceStore.Device)

	ctx, cancel := context.WithCancel(context.Background())

	client := &Client{
		Messagix:          msgClient,
		DeviceStore:       deviceStore,
		Logger:            logger,
		Platform:          platform,
		eventChan:         make(chan *Event, 100),
		ctx:               ctx,
		cancel:            cancel,
		threadCache:       make(map[int64]*Thread),
		recentUnreactions: make(map[string]int64),
		deviceRestored:    deviceRestored,
	}
	if logLevel != zerolog.Disabled {
		client.diagOut = os.Stderr
		deviceStore.diagOut = os.Stderr
	}
	// Unconfigured, libsignal prints its warnings and errors to stdout: this process's JSON-RPC channel.
	var signalLog signallog.Loggable = signalDiag{out: io.Discard}
	if client.diagOut != nil {
		signalLog = signalDiag{out: client.diagOut}
	}
	signallog.Setup(&signalLog)

	// Snapshots go to the parent app (which stores them) unless the device is memory-only or file-backed.
	if !cfg.E2EEMemoryOnly && (cfg.DeviceData != "" || cfg.DevicePath == "") {
		deviceStore.setOnDataChanged(func(data string) {
			if ctx.Err() != nil {
				return // disconnected: eventChan is closed
			}
			client.emitEvent(EventDeviceDataChanged, map[string]interface{}{
				"deviceData": data,
			})
		})
	}

	// Set event handler
	msgClient.SetEventHandler(client.handleEvent)

	return client, nil
}

// Connect connects to Messenger
func (c *Client) Connect() (*UserInfo, *InitialData, error) {
	// Load messages page
	currentUser, initialTable, err := c.Messagix.LoadMessagesPage(c.ctx)
	if err != nil {
		return nil, nil, err
	}
	if initialTable != nil {
		for _, thread := range initialTable.LSDeleteThenInsertThread {
			c.cacheThread(convertThread(thread))
		}
	}

	// Extract user info
	userInfo := &UserInfo{
		Name:     currentUser.GetName(),
		Username: currentUser.GetUsername(),
		ID:       currentUser.GetFBID(),
	}
	c.FBID = userInfo.ID

	// Connect socket
	if err := c.Messagix.Connect(c.ctx); err != nil {
		return nil, nil, err
	}

	return userInfo, nil, nil
}

// ConnectE2EE sets up and connects the E2EE client
func (c *Client) ConnectE2EE() error {
	if c.E2EE != nil && c.E2EE.IsConnected() {
		return nil
	}

	// Prepare E2EE client
	e2eeClient, err := c.Messagix.PrepareE2EEClient()
	if err != nil {
		return err
	}
	c.E2EE = e2eeClient
	if c.diagOut != nil {
		e2eeClient.Log = diagLog{Logger: e2eeClient.Log, out: c.diagOut}
	}

	// A restored device already has its server identity; registering again would replace it.
	registered := needsE2EERegistration(c.DeviceStore.Device)
	if registered {
		if err := c.Messagix.RegisterE2EE(c.ctx, c.FBID); err != nil {
			return err
		}
		if err := c.DeviceStore.Save(); err != nil {
			return err
		}
	}

	if c.diagOut != nil {
		fmt.Fprintf(c.diagOut, "INF [bridge] E2EE device ready device=%d restored=%t registered=%t\n",
			c.DeviceStore.Device.ID.Device, c.deviceRestored, registered)
	}

	// Handler first so messages queued while the app was closed are not missed on connect.
	c.E2EE.AddEventHandler(c.handleE2EEEvent)
	if err := c.E2EE.Connect(); err != nil {
		return err
	}

	return nil
}

// diagnosticMarkers pick the whatsmeow log lines that explain why an E2EE message could not be
// decrypted: the decrypt error itself, the retry receipts, and the prekey counts around an upload.
var diagnosticMarkers = []string{
	"Error decrypting", "error while trying to decrypt", "Unavailable message",
	"retry receipt", "prekey", "Prekey", "passive", "Successfully authenticated",
}

// diagLog wraps whatsmeow's logger. The release build runs the bridge at error level, which hides
// the lines above; they are written to out whatever the level, the rest goes to the wrapped logger.
// They carry message ids, sender ids and error text, never keys or message content.
type diagLog struct {
	waLog.Logger
	out io.Writer
}

func (d diagLog) diagnostic(level, msg string, args []any) bool {
	line := fmt.Sprintf(msg, args...)
	for _, marker := range diagnosticMarkers {
		if strings.Contains(line, marker) {
			fmt.Fprintf(d.out, "%s [whatsmeow] %s\n", level, line)
			return true
		}
	}
	return false
}

func (d diagLog) Warnf(msg string, args ...any) {
	if !d.diagnostic("WRN", msg, args) {
		d.Logger.Warnf(msg, args...)
	}
}

func (d diagLog) Infof(msg string, args ...any) {
	if !d.diagnostic("INF", msg, args) {
		d.Logger.Infof(msg, args...)
	}
}

func (d diagLog) Debugf(msg string, args ...any) {
	if !d.diagnostic("DBG", msg, args) {
		d.Logger.Debugf(msg, args...)
	}
}

func (d diagLog) Sub(module string) waLog.Logger {
	return diagLog{Logger: d.Logger.Sub(module), out: d.out}
}

// signalDiag receives libsignal's own log lines. Its warnings and errors name the step of a decrypt
// that failed (MAC, chain key, message keys, version) and carry nothing else. Its debug lines dump
// session state and keys, so only the two that describe an incoming prekey message are kept.
type signalDiag struct{ out io.Writer }

func (s signalDiag) Debug(caller, msg string) {
	if strings.HasPrefix(msg, "Processing message with PreKeyID") || strings.HasPrefix(msg, "We've already setup a session") {
		fmt.Fprintf(s.out, "DBG [libsignal] %s %s\n", caller, msg)
	}
}
func (s signalDiag) Info(string, string) {}
func (s signalDiag) Warning(caller, msg string) {
	fmt.Fprintf(s.out, "WRN [libsignal] %s %s\n", caller, msg)
}
func (s signalDiag) Error(caller, msg string) {
	fmt.Fprintf(s.out, "ERR [libsignal] %s %s\n", caller, msg)
}
func (s signalDiag) Configure(string) {}

// describeOwnBundle compares the prekey bundle Facebook hands to senders for this device with the keys
// the device holds. A sender builds its session from that bundle, so any difference makes everything
// it sends undecryptable. Only match/mismatch and key ids are reported.
func describeOwnBundle(ds *DeviceStore, b *prekey.Bundle) string {
	if b == nil {
		return "E2EE self-check: server returned no bundle for this device"
	}
	word := func(same bool) string {
		if same {
			return "match"
		}
		return "MISMATCH"
	}
	d := ds.Device
	oneTime := "none"
	if b.PreKey() != nil && !b.PreKeyID().IsEmpty {
		id := b.PreKeyID().Value
		pk, _ := ds.GetPreKey(context.Background(), id)
		oneTime = fmt.Sprintf("%s(id=%d)", word(pk != nil && *pk.Pub == b.PreKey().PublicKey()), id)
	}
	return fmt.Sprintf("E2EE self-check: identity=%s signedPreKey=%s(id=%d) oneTime=%s registration=%s",
		word(*d.IdentityKey.Pub == b.IdentityKey().PublicKey().PublicKey()),
		word(b.SignedPreKeyID() == d.SignedPreKey.KeyID && *d.SignedPreKey.Pub == b.SignedPreKey().PublicKey()), b.SignedPreKeyID(),
		oneTime, word(b.RegistrationID() == d.RegistrationID))
}

// selfCheckOwnBundle runs describeOwnBundle against the live server once the E2EE socket is up.
// It costs one one-time prekey per connect.
func (c *Client) selfCheckOwnBundle() {
	if c.diagOut == nil || c.E2EE == nil || c.DeviceStore.Device.ID == nil {
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
	defer cancel()
	var bundle *prekey.Bundle
	for _, b := range c.E2EE.DangerousInternals().FetchPreKeysNoError(ctx, []waTypes.JID{*c.DeviceStore.Device.ID}) {
		bundle = b
	}
	fmt.Fprintf(c.diagOut, "INF [bridge] %s\n", describeOwnBundle(c.DeviceStore, bundle))
}

// trace writes one store diagnostic line: which session, identity or one-time prekey was stored or
// asked for. Stored bytes are identified by blobTag, never written.
func (ds *DeviceStore) trace(format string, args ...any) {
	if ds.diagOut != nil {
		fmt.Fprintf(ds.diagOut, "DBG [bridge] "+format+"\n", args...)
	}
}

func blobTag(b []byte) string {
	if b == nil {
		return "none"
	}
	sum := sha256.Sum256(b)
	return fmt.Sprintf("len=%d h=%x", len(b), sum[:4])
}

// needsE2EERegistration is true until RegisterE2EE has assigned the device a server identity
// (messagix e2ee-register.go sets device.ID after icdc_register).
func needsE2EERegistration(device *store.Device) bool {
	return device == nil || device.ID == nil || device.ID.User == "" || device.ID.Device == 0
}

// Disconnect disconnects from Messenger
func (c *Client) Disconnect() {
	c.cancel()
	if c.E2EE != nil && c.E2EE.IsConnected() {
		c.E2EE.Disconnect()
	}
	c.Messagix.Disconnect()
	close(c.eventChan)
}

// IsConnected returns true if connected
func (c *Client) IsConnected() bool {
	return c.Messagix != nil
}

// IsE2EEConnected returns true if E2EE is connected
func (c *Client) IsE2EEConnected() bool {
	return c.E2EE != nil && c.E2EE.IsConnected()
}

// Events returns the event channel
func (c *Client) Events() <-chan *Event {
	return c.eventChan
}

// DeviceStore manages the E2EE device persistently
type DeviceStore struct {
	Device        *store.Device
	path          string
	mu            sync.RWMutex
	identities    map[string][32]byte
	sessions      map[string][]byte
	preKeys       map[uint32]*keys.PreKey
	senderKeys    map[string][]byte
	nextPreKeyID  uint32
	// preKeySeed: one-time prekeys are derived from it by id (derivePreKey), so they can be recomputed
	// after a restart even when the snapshot taken after an upload never reached storage.
	preKeySeed    []byte
	usedPreKeys   map[uint32]struct{} // derived one-time prekeys that were consumed
	onDataChanged func(string) // callback when data changes (for deviceData mode)
	saveMu        sync.Mutex   // serialises snapshots so they are published in order
	deleted       bool         // set by DeleteDevice (server logged the device out); Save is then a no-op
	diagOut       io.Writer    // decrypt diagnostics (trace); nil writes nothing
	snapshotQueued atomic.Bool // a coalesced snapshot is already scheduled (saveSoon)
}

// deviceSnapshotDelay bounds how often a snapshot-mode store publishes after mutations.
var deviceSnapshotDelay = 100 * time.Millisecond

// saveSoon persists after a store mutation. A file-backed store writes right away as before. A
// snapshot-mode store publishes one snapshot per deviceSnapshotDelay: decrypting a backlog of
// queued messages would otherwise emit a full-state event per session write and crowd message
// events out of the bounded event channel.
func (ds *DeviceStore) saveSoon() {
	if ds.path != "" {
		go ds.Save()
		return
	}
	if ds.snapshotQueued.CompareAndSwap(false, true) {
		time.AfterFunc(deviceSnapshotDelay, func() {
			ds.snapshotQueued.Store(false)
			ds.Save()
		})
	}
}

func (ds *DeviceStore) setOnDataChanged(fn func(string)) {
	ds.saveMu.Lock()
	ds.onDataChanged = fn
	ds.saveMu.Unlock()
}

// DeviceJSON for JSON serialization
type DeviceJSON struct {
	NoiseKeyPriv     string            `json:"noise_key_priv"`
	IdentityKeyPriv  string            `json:"identity_key_priv"`
	SignedPreKeyPriv string            `json:"signed_pre_key_priv"`
	SignedPreKeyID   uint32            `json:"signed_pre_key_id"`
	SignedPreKeySig  string            `json:"signed_pre_key_sig"`
	RegistrationID   uint32            `json:"registration_id"`
	AdvSecretKey     string            `json:"adv_secret_key"`
	FacebookUUID     string            `json:"facebook_uuid"`
	JIDUser          string            `json:"jid_user,omitempty"`
	JIDDevice        uint16            `json:"jid_device,omitempty"`
	Identities       map[string]string `json:"identities,omitempty"`
	Sessions         map[string]string `json:"sessions,omitempty"`
	PreKeys          map[string]string `json:"pre_keys,omitempty"`
	SenderKeys       map[string]string `json:"sender_keys,omitempty"`
	NextPreKeyID     uint32            `json:"next_pre_key_id"`
	PreKeySeed       string            `json:"pre_key_seed,omitempty"`
	UsedPreKeys      []uint32          `json:"used_pre_keys,omitempty"`
}

// maxPreKeyID is the largest one-time prekey id the Signal protocol uses (medium id).
const maxPreKeyID = 0xFFFFFF

func newPreKeySeed() []byte {
	seed := make([]byte, 32)
	if _, err := cryptorand.Read(seed); err != nil {
		panic(err) // no entropy: nothing safe can be generated
	}
	return seed
}

// loadPreKeyState reads the prekey seed and the consumed ids from stored state. A state without a
// valid seed leaves preKeySeed nil (file-backed legacy state keeps its stored prekeys).
func (ds *DeviceStore) loadPreKeyState(deviceJSON *DeviceJSON) {
	if seed, err := base64.StdEncoding.DecodeString(deviceJSON.PreKeySeed); err == nil && len(seed) == 32 {
		ds.preKeySeed = seed
	}
	for _, id := range deviceJSON.UsedPreKeys {
		ds.usedPreKeys[id] = struct{}{}
	}
}

// derivePreKey returns the one-time prekey for id: the same key for the same seed and id, in every run.
func (ds *DeviceStore) derivePreKey(id uint32) *keys.PreKey {
	mac := hmac.New(sha256.New, ds.preKeySeed)
	mac.Write([]byte("maihub-one-time-prekey"))
	var idBytes [4]byte
	binary.BigEndian.PutUint32(idBytes[:], id)
	mac.Write(idBytes[:])
	var priv [32]byte
	copy(priv[:], mac.Sum(nil))
	priv[0] &= 248 // Curve25519 clamping, as keys.NewKeyPair does
	priv[31] &= 127
	priv[31] |= 64
	return &keys.PreKey{KeyPair: *keys.NewKeyPairFromPrivateKey(priv), KeyID: id}
}

// NewDeviceStore creates or loads a device store
func NewDeviceStore(path string) (*DeviceStore, error) {
	ds := &DeviceStore{
		path:         path,
		identities:   make(map[string][32]byte),
		sessions:     make(map[string][]byte),
		preKeys:      make(map[uint32]*keys.PreKey),
		senderKeys:   make(map[string][]byte),
		nextPreKeyID: 1,
		usedPreKeys:  make(map[uint32]struct{}),
	}

	if data, err := os.ReadFile(path); err == nil {
		var deviceJSON DeviceJSON
		if err := json.Unmarshal(data, &deviceJSON); err != nil {
			return nil, err
		}

		noisePriv, _ := base64.StdEncoding.DecodeString(deviceJSON.NoiseKeyPriv)
		identityPriv, _ := base64.StdEncoding.DecodeString(deviceJSON.IdentityKeyPriv)
		signedPreKeyPriv, _ := base64.StdEncoding.DecodeString(deviceJSON.SignedPreKeyPriv)
		signedPreKeySig, _ := base64.StdEncoding.DecodeString(deviceJSON.SignedPreKeySig)
		advSecretKey, _ := base64.StdEncoding.DecodeString(deviceJSON.AdvSecretKey)

		if len(noisePriv) != 32 || len(identityPriv) != 32 || len(signedPreKeyPriv) != 32 || len(signedPreKeySig) != 64 {
			return nil, errors.New("invalid key lengths in stored device")
		}

		ds.Device = &store.Device{
			NoiseKey:    keys.NewKeyPairFromPrivateKey(*(*[32]byte)(noisePriv)),
			IdentityKey: keys.NewKeyPairFromPrivateKey(*(*[32]byte)(identityPriv)),
			SignedPreKey: &keys.PreKey{
				KeyPair:   *keys.NewKeyPairFromPrivateKey(*(*[32]byte)(signedPreKeyPriv)),
				KeyID:     deviceJSON.SignedPreKeyID,
				Signature: (*[64]byte)(signedPreKeySig),
			},
			RegistrationID: deviceJSON.RegistrationID,
			AdvSecretKey:   advSecretKey,
		}

		if deviceJSON.FacebookUUID != "" {
			ds.Device.FacebookUUID, _ = uuid.Parse(deviceJSON.FacebookUUID)
		}
		if deviceJSON.JIDUser != "" {
			ds.Device.ID = &waTypes.JID{User: deviceJSON.JIDUser, Device: deviceJSON.JIDDevice, Server: waTypes.MessengerServer}
		}

		ds.nextPreKeyID = deviceJSON.NextPreKeyID
		ds.loadPreKeyState(&deviceJSON)

		// Load identities
		for k, v := range deviceJSON.Identities {
			decoded, _ := base64.StdEncoding.DecodeString(v)
			if len(decoded) == 32 {
				ds.identities[k] = *(*[32]byte)(decoded)
			}
		}

		// Load sessions
		for k, v := range deviceJSON.Sessions {
			decoded, _ := base64.StdEncoding.DecodeString(v)
			ds.sessions[k] = decoded
		}

		// Load pre-keys
		for idStr, v := range deviceJSON.PreKeys {
			var id uint32
			fmt.Sscanf(idStr, "%d", &id)
			decoded, _ := base64.StdEncoding.DecodeString(v)
			if len(decoded) == 32 {
				ds.preKeys[id] = &keys.PreKey{
					KeyPair: *keys.NewKeyPairFromPrivateKey(*(*[32]byte)(decoded)),
					KeyID:   id,
				}
			}
		}

		// Load sender keys
		for k, v := range deviceJSON.SenderKeys {
			decoded, _ := base64.StdEncoding.DecodeString(v)
			ds.senderKeys[k] = decoded
		}
	} else {
		// Create new device
		ds.Device = &store.Device{
			NoiseKey:       keys.NewKeyPair(),
			IdentityKey:    keys.NewKeyPair(),
			RegistrationID: rand.Uint32()%16380 + 1,
			AdvSecretKey:   make([]byte, 32),
		}
		rand.Read(ds.Device.AdvSecretKey)
		ds.Device.SignedPreKey = ds.Device.IdentityKey.CreateSignedPreKey(1)
		ds.preKeySeed = newPreKeySeed()
		ds.Device.FacebookUUID = uuid.New()
		if dir := filepath.Dir(path); dir != "." && dir != "" {
			if err := os.MkdirAll(dir, 0700); err != nil {
				return nil, err
			}
		}
		if err := ds.Save(); err != nil {
			return nil, err
		}
	}

	// Set store interfaces
	ds.Device.Identities = ds
	ds.Device.Sessions = ds
	ds.Device.PreKeys = ds
	ds.Device.SenderKeys = ds
	ds.Device.Container = ds
	ds.Device.AppStateKeys = ds
	ds.Device.AppState = ds
	ds.Device.Contacts = ds
	ds.Device.ChatSettings = ds
	ds.Device.MsgSecrets = ds
	ds.Device.PrivacyTokens = ds
	ds.Device.LIDs = ds
	ds.Device.EventBuffer = ds
	ds.Device.Initialized = true

	if ds.Device.Account == nil {
		ds.Device.Account = &waAdv.ADVSignedDeviceIdentity{
			Details: make([]byte, 0), AccountSignatureKey: make([]byte, 32),
			AccountSignature: make([]byte, 64), DeviceSignature: make([]byte, 64),
		}
	}

	return ds, nil
}

// GetDeviceData returns the device data as a JSON string
func (ds *DeviceStore) GetDeviceData() (string, error) {
	ds.mu.RLock()
	defer ds.mu.RUnlock()

	deviceJSON := DeviceJSON{
		NoiseKeyPriv:     base64.StdEncoding.EncodeToString(ds.Device.NoiseKey.Priv[:]),
		IdentityKeyPriv:  base64.StdEncoding.EncodeToString(ds.Device.IdentityKey.Priv[:]),
		SignedPreKeyPriv: base64.StdEncoding.EncodeToString(ds.Device.SignedPreKey.Priv[:]),
		SignedPreKeyID:   ds.Device.SignedPreKey.KeyID,
		SignedPreKeySig:  base64.StdEncoding.EncodeToString(ds.Device.SignedPreKey.Signature[:]),
		RegistrationID:   ds.Device.RegistrationID,
		AdvSecretKey:     base64.StdEncoding.EncodeToString(ds.Device.AdvSecretKey),
		FacebookUUID:     ds.Device.FacebookUUID.String(),
		NextPreKeyID:     ds.nextPreKeyID,
		PreKeySeed:       base64.StdEncoding.EncodeToString(ds.preKeySeed),
		Identities:       make(map[string]string),
		Sessions:         make(map[string]string),
		PreKeys:          make(map[string]string),
		SenderKeys:       make(map[string]string),
	}

	if ds.Device.ID != nil {
		deviceJSON.JIDUser = ds.Device.ID.User
		deviceJSON.JIDDevice = ds.Device.ID.Device
	}

	// Save identities
	for k, v := range ds.identities {
		deviceJSON.Identities[k] = base64.StdEncoding.EncodeToString(v[:])
	}

	// Save sessions
	for k, v := range ds.sessions {
		deviceJSON.Sessions[k] = base64.StdEncoding.EncodeToString(v)
	}

	// Save pre-keys
	for id, pk := range ds.preKeys {
		deviceJSON.PreKeys[fmt.Sprintf("%d", id)] = base64.StdEncoding.EncodeToString(pk.Priv[:])
	}

	// Save sender keys
	for k, v := range ds.senderKeys {
		deviceJSON.SenderKeys[k] = base64.StdEncoding.EncodeToString(v)
	}

	for id := range ds.usedPreKeys {
		deviceJSON.UsedPreKeys = append(deviceJSON.UsedPreKeys, id)
	}
	slices.Sort(deviceJSON.UsedPreKeys)

	data, err := json.MarshalIndent(deviceJSON, "", "  ")
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// Save saves the device store to disk (only if path is set)
func (ds *DeviceStore) Save() error {
	ds.saveMu.Lock()
	defer ds.saveMu.Unlock()
	if ds.deleted {
		return nil
	}
	data, err := ds.GetDeviceData()
	if err != nil {
		return err
	}

	if ds.path == "" {
		// No path set, emit callback instead of saving to file
		if ds.onDataChanged != nil {
			ds.onDataChanged(data)
		}
		return nil
	}

	return os.WriteFile(ds.path, []byte(data), 0600)
}

// NewDeviceStoreFromData creates a device store from JSON data string (no file I/O)
func NewDeviceStoreFromData(dataStr string) (*DeviceStore, error) {
	ds := &DeviceStore{
		path:         "", // Empty path means no file saving
		identities:   make(map[string][32]byte),
		sessions:     make(map[string][]byte),
		preKeys:      make(map[uint32]*keys.PreKey),
		senderKeys:   make(map[string][]byte),
		nextPreKeyID: 1,
		usedPreKeys:  make(map[uint32]struct{}),
	}

	var deviceJSON DeviceJSON
	if err := json.Unmarshal([]byte(dataStr), &deviceJSON); err != nil {
		return nil, err
	}

	noisePriv, _ := base64.StdEncoding.DecodeString(deviceJSON.NoiseKeyPriv)
	identityPriv, _ := base64.StdEncoding.DecodeString(deviceJSON.IdentityKeyPriv)
	signedPreKeyPriv, _ := base64.StdEncoding.DecodeString(deviceJSON.SignedPreKeyPriv)
	signedPreKeySig, _ := base64.StdEncoding.DecodeString(deviceJSON.SignedPreKeySig)
	advSecretKey, _ := base64.StdEncoding.DecodeString(deviceJSON.AdvSecretKey)

	if len(noisePriv) != 32 || len(identityPriv) != 32 || len(signedPreKeyPriv) != 32 || len(signedPreKeySig) != 64 {
		return nil, errors.New("invalid key lengths in device data")
	}

	ds.Device = &store.Device{
		NoiseKey:    keys.NewKeyPairFromPrivateKey(*(*[32]byte)(noisePriv)),
		IdentityKey: keys.NewKeyPairFromPrivateKey(*(*[32]byte)(identityPriv)),
		SignedPreKey: &keys.PreKey{
			KeyPair:   *keys.NewKeyPairFromPrivateKey(*(*[32]byte)(signedPreKeyPriv)),
			KeyID:     deviceJSON.SignedPreKeyID,
			Signature: (*[64]byte)(signedPreKeySig),
		},
		RegistrationID: deviceJSON.RegistrationID,
		AdvSecretKey:   advSecretKey,
	}

	if deviceJSON.FacebookUUID != "" {
		ds.Device.FacebookUUID, _ = uuid.Parse(deviceJSON.FacebookUUID)
	}
	if deviceJSON.JIDUser != "" {
		ds.Device.ID = &waTypes.JID{User: deviceJSON.JIDUser, Device: deviceJSON.JIDDevice, Server: waTypes.MessengerServer}
	}

	ds.nextPreKeyID = deviceJSON.NextPreKeyID
	ds.loadPreKeyState(&deviceJSON)
	if ds.preKeySeed == nil {
		// Stored by 26.37.0: its one-time prekeys were random and may be missing here while Facebook
		// still hands them out, so the device cannot be trusted to decrypt. Register a new one.
		return nil, errors.New("stored device has no prekey seed")
	}

	// Load identities
	for k, v := range deviceJSON.Identities {
		decoded, _ := base64.StdEncoding.DecodeString(v)
		if len(decoded) == 32 {
			ds.identities[k] = *(*[32]byte)(decoded)
		}
	}

	// Load sessions
	for k, v := range deviceJSON.Sessions {
		decoded, _ := base64.StdEncoding.DecodeString(v)
		ds.sessions[k] = decoded
	}

	// Load pre-keys
	for idStr, v := range deviceJSON.PreKeys {
		var id uint32
		fmt.Sscanf(idStr, "%d", &id)
		decoded, _ := base64.StdEncoding.DecodeString(v)
		if len(decoded) == 32 {
			ds.preKeys[id] = &keys.PreKey{
				KeyPair: *keys.NewKeyPairFromPrivateKey(*(*[32]byte)(decoded)),
				KeyID:   id,
			}
		}
	}

	// Load sender keys
	for k, v := range deviceJSON.SenderKeys {
		decoded, _ := base64.StdEncoding.DecodeString(v)
		ds.senderKeys[k] = decoded
	}

	// Set store interfaces
	ds.Device.Identities = ds
	ds.Device.Sessions = ds
	ds.Device.PreKeys = ds
	ds.Device.SenderKeys = ds
	ds.Device.Container = ds
	ds.Device.AppStateKeys = ds
	ds.Device.AppState = ds
	ds.Device.Contacts = ds
	ds.Device.ChatSettings = ds
	ds.Device.MsgSecrets = ds
	ds.Device.PrivacyTokens = ds
	ds.Device.LIDs = ds
	ds.Device.EventBuffer = ds
	ds.Device.Initialized = true

	if ds.Device.Account == nil {
		ds.Device.Account = &waAdv.ADVSignedDeviceIdentity{
			Details: make([]byte, 0), AccountSignatureKey: make([]byte, 32),
			AccountSignature: make([]byte, 64), DeviceSignature: make([]byte, 64),
		}
	}

	return ds, nil
}

// NewDeviceStoreMemoryOnly creates a new device store that only lives in memory
// No file saving, no events emitted - state is lost when client disconnects
func NewDeviceStoreMemoryOnly() (*DeviceStore, error) {
	ds := &DeviceStore{
		path:         "", // Empty path means no file saving
		identities:   make(map[string][32]byte),
		sessions:     make(map[string][]byte),
		preKeys:      make(map[uint32]*keys.PreKey),
		senderKeys:   make(map[string][]byte),
		nextPreKeyID: 1,
		usedPreKeys:  make(map[uint32]struct{}),
		// onDataChanged is nil - no callback
	}

	// Create new device
	ds.Device = &store.Device{
		NoiseKey:       keys.NewKeyPair(),
		IdentityKey:    keys.NewKeyPair(),
		RegistrationID: rand.Uint32()%16380 + 1,
		AdvSecretKey:   make([]byte, 32),
	}
	rand.Read(ds.Device.AdvSecretKey)
	ds.Device.SignedPreKey = ds.Device.IdentityKey.CreateSignedPreKey(1)
	ds.preKeySeed = newPreKeySeed()
	ds.Device.FacebookUUID = uuid.New()

	// Set store interfaces
	ds.Device.Identities = ds
	ds.Device.Sessions = ds
	ds.Device.PreKeys = ds
	ds.Device.SenderKeys = ds
	ds.Device.Container = ds
	ds.Device.AppStateKeys = ds
	ds.Device.AppState = ds
	ds.Device.Contacts = ds
	ds.Device.ChatSettings = ds
	ds.Device.MsgSecrets = ds
	ds.Device.PrivacyTokens = ds
	ds.Device.LIDs = ds
	ds.Device.EventBuffer = ds
	ds.Device.Initialized = true

	if ds.Device.Account == nil {
		ds.Device.Account = &waAdv.ADVSignedDeviceIdentity{
			Details: make([]byte, 0), AccountSignatureKey: make([]byte, 32),
			AccountSignature: make([]byte, 64), DeviceSignature: make([]byte, 64),
		}
	}

	return ds, nil
}

// GetCookies returns the current cookies from the messagix client
func (c *Client) GetCookies() map[string]string {
	if c.Messagix == nil {
		return nil
	}
	cks := c.Messagix.GetCookies()
	if cks == nil {
		return nil
	}
	result := make(map[string]string)
	for k, v := range cks.GetAll() {
		result[string(k)] = v
	}
	return result
}

// PushKeys holds the web push notification keys
type PushKeys struct {
	P256DH []byte `json:"p256dh"`
	Auth   []byte `json:"auth"`
}

// RegisterPushNotificationsOptions holds options for push notification registration
type RegisterPushNotificationsOptions struct {
	Endpoint string `json:"endpoint"`
	P256DH   string `json:"p256dh"` // base64 encoded
	Auth     string `json:"auth"`   // base64 encoded
}

// RegisterPushNotifications registers web push notification endpoint
func (c *Client) RegisterPushNotifications(ctx context.Context, opts *RegisterPushNotificationsOptions) error {
	if c.Messagix == nil {
		return fmt.Errorf("client not connected")
	}

	// Decode base64 keys
	p256dh, err := base64.RawURLEncoding.DecodeString(opts.P256DH)
	if err != nil {
		return fmt.Errorf("invalid p256dh key: %w", err)
	}
	auth, err := base64.RawURLEncoding.DecodeString(opts.Auth)
	if err != nil {
		return fmt.Errorf("invalid auth key: %w", err)
	}

	return c.Messagix.Facebook.RegisterPushNotifications(ctx, opts.Endpoint, messagix.PushKeys{
		P256DH: p256dh,
		Auth:   auth,
	})
}

// Helper to convert thread
func convertThread(t *table.LSDeleteThenInsertThread) *Thread {
	return &Thread{
		ID:                      t.ThreadKey,
		Type:                    int(t.ThreadType),
		Name:                    t.ThreadName,
		LastActivityTimestampMs: t.LastActivityTimestampMs,
		Snippet:                 t.Snippet,
	}
}

// Helper to convert message from LSUpsertMessage
func convertMessage(m *table.LSUpsertMessage) *Message {
	return &Message{
		ID:          m.MessageId,
		ThreadID:    m.ThreadKey,
		SenderID:    m.SenderId,
		Text:        m.Text,
		TimestampMs: m.TimestampMs,
	}
}

// Helper to convert message from LSInsertMessage
func convertInsertMessage(m *table.LSInsertMessage) *Message {
	return &Message{
		ID:          m.MessageId,
		ThreadID:    m.ThreadKey,
		SenderID:    m.SenderId,
		Text:        m.Text,
		TimestampMs: m.TimestampMs,
	}
}

// Helper to convert message from LSDeleteThenInsertMessage
func convertDeleteThenInsertMessage(m *table.LSDeleteThenInsertMessage) *Message {
	return &Message{
		ID:          m.MessageId,
		ThreadID:    m.ThreadKey,
		SenderID:    m.SenderId,
		Text:        m.Text,
		TimestampMs: m.TimestampMs,
	}
}

func (ds *DeviceStore) DeleteExpiredPrivacyTokens(ctx context.Context, olderThan time.Time) (int64, error) {
	return 0, nil
}
