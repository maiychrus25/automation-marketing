// Standalone E2EE bridge for fbchat-v2.
//
// Communicates with the Python parent process over stdin/stdout using
// line-delimited JSON. Single-client per process (Python spawns one).
//
// Protocol
// --------
// Request  (Python -> bridge): one JSON object per line:
//     {"id": <int>, "method": "<name>", "params": {...}}
//
// Response (bridge -> Python): one JSON object per line:
//     {"id": <int>, "ok": true,  "data": {...}}
//     {"id": <int>, "ok": false, "error": "..."}
//
// Async event (bridge -> Python): one JSON object per line, no id:
//     {"event": {"type": "<name>", "data": {...}, "timestamp": <ms>}}
//
// Methods: newClient, connect, connectE2EE, isConnected, disconnect,
// sendMessage, fetchMessages, sendReaction, sendE2EEMessage, sendE2EEReaction,
// sendImage, sendFile, sendE2EESticker, sendE2EEAudio, sendE2EEVideo, sendE2EEDocument.
//
// Build:
//     go mod tidy
//     go build -ldflags="-s -w" -o ../build/fbchat-bridge-e2ee.exe .
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"fbchat-bridge-e2ee/bridge"
)

type request struct {
	ID     uint64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// parseFetchMessagesParams reads the fetchMessages params. threadId must be a JSON string
// (an optional "@…" suffix is dropped) so 17-digit ids stay exact; timeoutMs <= 0 gives 0
// (FetchThreadHistory then applies its own default) and is capped at 60 s.
func parseFetchMessagesParams(raw json.RawMessage) (threadID int64, beforeTs int64, beforeID string, timeout time.Duration, err error) {
	var params struct {
		ThreadID          string `json:"threadId"`
		BeforeTimestampMs int64  `json:"beforeTimestampMs"`
		BeforeMessageID   string `json:"beforeMessageId"`
		TimeoutMs         int64  `json:"timeoutMs"`
	}
	if err = json.Unmarshal(raw, &params); err != nil {
		return
	}
	if strings.TrimSpace(params.ThreadID) == "" {
		err = fmt.Errorf("threadId is required")
		return
	}
	threadID, perr := strconv.ParseInt(strings.TrimSpace(strings.SplitN(params.ThreadID, "@", 2)[0]), 10, 64)
	if perr != nil || threadID == 0 {
		threadID, err = 0, fmt.Errorf("invalid threadId %q", params.ThreadID)
		return
	}
	if params.TimeoutMs > 60000 {
		params.TimeoutMs = 60000
	}
	if params.TimeoutMs < 0 {
		params.TimeoutMs = 0
	}
	return threadID, params.BeforeTimestampMs, params.BeforeMessageID, time.Duration(params.TimeoutMs) * time.Millisecond, nil
}

// parseMarkReadParams reads the markRead params. threadId must be a JSON string holding a positive
// decimal id (no "@…" suffix) so 17-digit ids stay exact; a missing watermarkTs gives 0.
func parseMarkReadParams(raw json.RawMessage) (threadID int64, watermarkTs int64, err error) {
	var params struct {
		ThreadID    string `json:"threadId"`
		WatermarkTs int64  `json:"watermarkTs"`
	}
	if err = json.Unmarshal(raw, &params); err != nil {
		return
	}
	threadID, perr := strconv.ParseInt(strings.TrimSpace(params.ThreadID), 10, 64)
	if perr != nil || threadID <= 0 {
		return 0, 0, fmt.Errorf("invalid threadId %q", params.ThreadID)
	}
	if params.WatermarkTs < 0 {
		return 0, 0, fmt.Errorf("invalid watermarkTs %d", params.WatermarkTs)
	}
	return threadID, params.WatermarkTs, nil
}

// parseUserIDParam reads {"userId": "<digits>"}. Ids cross the Electron boundary as strings so
// values above 2^53 keep their precision.
func parseUserIDParam(raw json.RawMessage) (int64, error) {
	var params struct {
		UserID string `json:"userId"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return 0, err
	}
	userID, err := strconv.ParseInt(strings.TrimSpace(params.UserID), 10, 64)
	if err != nil || userID <= 0 {
		return 0, fmt.Errorf("invalid userId %q", params.UserID)
	}
	return userID, nil
}

type response struct {
	ID    uint64      `json:"id"`
	OK    bool        `json:"ok"`
	Data  interface{} `json:"data,omitempty"`
	Error string      `json:"error,omitempty"`
}

type eventEnvelope struct {
	Event *bridge.Event `json:"event"`
}

var (
	client   *bridge.Client
	stdoutMu sync.Mutex
)

func writeJSON(v interface{}) {
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func ok(id uint64, data interface{}) {
	writeJSON(response{ID: id, OK: true, Data: data})
}

func fail(id uint64, err error) {
	writeJSON(response{ID: id, OK: false, Error: err.Error()})
}

// pumpEvents copies events from the client to stdout asynchronously.
func pumpEvents(c *bridge.Client) {
	for evt := range c.Events() {
		if evt == nil {
			continue
		}
		writeJSON(eventEnvelope{Event: evt})
	}
}

func handle(req *request) {
	switch req.Method {
	case "newClient":
		if client != nil {
			fail(req.ID, fmt.Errorf("client already created"))
			return
		}
		var cfg bridge.ClientConfig
		if err := json.Unmarshal(req.Params, &cfg); err != nil {
			fail(req.ID, err)
			return
		}
		c, err := bridge.NewClient(&cfg)
		if err != nil {
			fail(req.ID, err)
			return
		}
		client = c
		go pumpEvents(client)
		ok(req.ID, map[string]interface{}{"ready": true})

	case "connect":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		user, _, err := client.Connect()
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{
			"user": user,
		})

	case "fetchMessages":
		// One page of a thread's history (bridge/history.go). The answer arrives
		// on the LightSpeed socket, so the wait runs in a goroutine: requests are
		// served one at a time and a blocking wait would hold up sends.
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		threadID, beforeTs, beforeID, timeout, err := parseFetchMessagesParams(req.Params)
		if err != nil {
			fail(req.ID, err)
			return
		}
		current, reqID := client, req.ID
		go func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					fmt.Fprintf(os.Stderr, "panic in fetchMessages: %v\n%s\n", recovered, debug.Stack())
					fail(reqID, fmt.Errorf("internal bridge error in fetchMessages: %v", recovered))
				}
			}()
			page, err := current.FetchThreadHistory(context.Background(), threadID, beforeTs, beforeID, timeout)
			if err != nil {
				fail(reqID, err)
				return
			}
			ok(reqID, page)
		}()

	case "markRead":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		threadID, watermarkTs, err := parseMarkReadParams(req.Params)
		if err != nil {
			fail(req.ID, err)
			return
		}
		if err := client.MarkRead(threadID, watermarkTs); err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{})

	case "getCookies":
		// Cookie hiện có của phiên (thư viện tự gộp cookie Facebook làm mới qua Set-Cookie), để app lưu lại bản mới.
		// Kết quả chứa cookie đăng nhập: chỉ trả về qua JSON-RPC, không ghi log.
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		ok(req.ID, map[string]interface{}{"cookies": client.GetCookies()})

	case "getUserInfo":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		userID, err := parseUserIDParam(req.Params)
		if err != nil {
			fail(req.ID, err)
			return
		}
		info, err := client.GetUserInfo(&bridge.GetUserInfoOptions{UserID: userID})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, info)

	case "connectE2EE":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		if err := client.ConnectE2EE(); err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{})

	case "isConnected":
		if client == nil {
			ok(req.ID, map[string]interface{}{"connected": false, "e2eeConnected": false})
			return
		}
		ok(req.ID, map[string]interface{}{
			"connected":     client.IsConnected(),
			"e2eeConnected": client.IsE2EEConnected(),
		})

	case "sendMessage":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var opts bridge.SendMessageOptions
		if err := json.Unmarshal(req.Params, &opts); err != nil {
			fail(req.ID, err)
			return
		}
		res, err := client.SendMessage(&opts)
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendReaction":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var p struct {
			ThreadID  int64  `json:"threadId"`
			MessageID string `json:"messageId"`
			Emoji     string `json:"emoji"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return
		}
		if err := client.SendReaction(p.ThreadID, p.MessageID, p.Emoji); err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{})

	case "sendImage":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var imgP struct {
			ThreadID  int64  `json:"threadId"`
			ImagePath string `json:"imagePath"`
			Caption   string `json:"caption"`
		}
		if err := json.Unmarshal(req.Params, &imgP); err != nil {
			fail(req.ID, err)
			return
		}
		imgData, err := os.ReadFile(imgP.ImagePath)
		if err != nil {
			fail(req.ID, fmt.Errorf("failed to read image file: %w", err))
			return
		}
		res, err := client.SendImage(&bridge.SendImageOptions{
			ThreadID: imgP.ThreadID,
			Data:     imgData,
			Filename: imgP.ImagePath,
			Caption:  imgP.Caption,
		})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendFile":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var fileP struct {
			ThreadID int64  `json:"threadId"`
			FilePath string `json:"filePath"`
			FileName string `json:"fileName"`
		}
		if err := json.Unmarshal(req.Params, &fileP); err != nil {
			fail(req.ID, err)
			return
		}
		fileData, err := os.ReadFile(fileP.FilePath)
		if err != nil {
			fail(req.ID, fmt.Errorf("failed to read file: %w", err))
			return
		}
		res, err := client.SendFile(&bridge.SendFileOptions{
			ThreadID: fileP.ThreadID,
			Data:     fileData,
			Filename: fileP.FileName,
		})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendE2EEMessage":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var p struct {
			ChatJID          string `json:"chatJid"`
			Text             string `json:"text"`
			ReplyToID        string `json:"replyToId,omitempty"`
			ReplyToSenderJID string `json:"replyToSenderJid,omitempty"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return
		}
		res, err := client.SendMessage(&bridge.SendMessageOptions{
			Text:                 p.Text,
			IsE2EE:               true,
			E2EEChatJID:          p.ChatJID,
			E2EEReplyToID:        p.ReplyToID,
			E2EEReplyToSenderJID: p.ReplyToSenderJID,
		})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendE2EEReaction":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var p struct {
			ChatJID   string `json:"chatJid"`
			MessageID string `json:"messageId"`
			SenderJID string `json:"senderJid"`
			Emoji     string `json:"emoji"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return
		}
		if err := client.SendE2EEReaction(p.ChatJID, p.MessageID, p.SenderJID, p.Emoji); err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{})

	case "sendE2EESticker":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var opts bridge.SendE2EEStickerOptions
		if err := json.Unmarshal(req.Params, &opts); err != nil {
			fail(req.ID, err)
			return
		}
		res, err := client.SendE2EESticker(&opts)
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendE2EEAudio":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var ap struct {
			ChatJID   string `json:"chatJid"`
			AudioPath string `json:"audioPath"`
			MimeType  string `json:"mimeType"`
		}
		if err := json.Unmarshal(req.Params, &ap); err != nil {
			fail(req.ID, err)
			return
		}
		aData, err := os.ReadFile(ap.AudioPath)
		if err != nil {
			fail(req.ID, fmt.Errorf("failed to read audio file: %w", err))
			return
		}
		mimeType := ap.MimeType
		if mimeType == "" {
			mimeType = "audio/mpeg"
		}
		res, err := client.SendE2EEAudio(&bridge.SendE2EEAudioOptions{
			ChatJID:  ap.ChatJID,
			Data:     aData,
			MimeType: mimeType,
			PTT:      false,
		})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendE2EEVideo":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var vp struct {
			ChatJID   string `json:"chatJid"`
			VideoPath string `json:"videoPath"`
			Caption   string `json:"caption"`
		}
		if err := json.Unmarshal(req.Params, &vp); err != nil {
			fail(req.ID, err)
			return
		}
		vData, err := os.ReadFile(vp.VideoPath)
		if err != nil {
			fail(req.ID, fmt.Errorf("failed to read video file: %w", err))
			return
		}
		res, err := client.SendE2EEVideo(&bridge.SendE2EEVideoOptions{
			ChatJID:  vp.ChatJID,
			Data:     vData,
			MimeType: "video/mp4",
			Caption:  vp.Caption,
		})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendE2EEImage":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var p struct {
			ChatJID   string `json:"chatJid"`
			ImagePath string `json:"imagePath"`
			Caption   string `json:"caption"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return
		}
		data, err := os.ReadFile(p.ImagePath)
		if err != nil {
			fail(req.ID, fmt.Errorf("failed to read image file: %w", err))
			return
		}
		mimeType := "image/jpeg"
		if strings.HasSuffix(strings.ToLower(p.ImagePath), ".png") {
			mimeType = "image/png"
		} else if strings.HasSuffix(strings.ToLower(p.ImagePath), ".gif") {
			mimeType = "image/gif"
		} else if strings.HasSuffix(strings.ToLower(p.ImagePath), ".webp") {
			mimeType = "image/webp"
		}
		res, err := client.SendE2EEImage(&bridge.SendE2EEImageOptions{
			ChatJID:  p.ChatJID,
			Data:     data,
			MimeType: mimeType,
			Caption:  p.Caption,
		})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendE2EEDocument":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var docP struct {
			ChatJID  string `json:"chatJid"`
			FilePath string `json:"filePath"`
			FileName string `json:"fileName"`
		}
		if err := json.Unmarshal(req.Params, &docP); err != nil {
			fail(req.ID, err)
			return
		}
		docData, err := os.ReadFile(docP.FilePath)
		if err != nil {
			fail(req.ID, fmt.Errorf("failed to read file: %w", err))
			return
		}
		res, err := client.SendE2EEDocument(&bridge.SendE2EEDocumentOptions{
			ChatJID:  docP.ChatJID,
			Data:     docData,
			Filename: docP.FileName,
		})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "downloadE2EEAttachment":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var dlP bridge.DownloadE2EEMediaOptions
		if err := json.Unmarshal(req.Params, &dlP); err != nil {
			fail(req.ID, err)
			return
		}
		res, err := client.DownloadE2EEMedia(&dlP)
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "disconnect":
		if client != nil {
			client.Disconnect()
			client = nil
		}
		ok(req.ID, map[string]interface{}{})

	default:
		fail(req.ID, fmt.Errorf("unknown method: %s", req.Method))
	}
}

func main() {
	// Use a large buffer because initial sync data can be substantial.
	reader := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			var req request
			if jerr := json.Unmarshal(line, &req); jerr != nil {
				fail(0, fmt.Errorf("invalid json: %w", jerr))
			} else {
				handle(&req)
			}
		}
		if err != nil {
			if err == io.EOF {
				if client != nil {
					client.Disconnect()
				}
				return
			}
			fmt.Fprintln(os.Stderr, "stdin error:", err)
			return
		}
	}
}
