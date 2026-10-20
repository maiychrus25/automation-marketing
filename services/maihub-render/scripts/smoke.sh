#!/usr/bin/env bash
# Kiểm tra nhanh máy chủ render bằng API thật: health, 1 video từ mẫu, 1 HTML "xấu".
# Dùng: RENDER_URL=https://render-1-2-3-4.sslip.io RENDER_KEY=<khoá gốc> scripts/smoke.sh
# Cần: curl; ffmpeg (chỉ để tạo ảnh mẫu và chụp khung hình, không bắt buộc nếu có sẵn ảnh trong SMOKE_DIR).
set -euo pipefail

URL="${RENDER_URL:-http://localhost:8080}"
KEY="${RENDER_KEY:-}"
OUT="${SMOKE_DIR:-$(mktemp -d)}"
MAX_WAIT="${SMOKE_MAX_WAIT:-900}"
mkdir -p "$OUT"
[ -n "$KEY" ] || { echo "Thiếu RENDER_KEY (khoá gốc từ npm run keygen)." >&2; exit 1; }

auth=(-H "Authorization: Bearer $KEY")
json_field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

echo "== 1. Health"
curl -fsS "$URL/v1/health"; echo

echo "== 2. Ảnh mẫu"
for i in 1 2 3; do
  f="$OUT/sample$i.jpg"
  if [ ! -s "$f" ]; then
    command -v ffmpeg >/dev/null || { echo "Không có ffmpeg để tạo ảnh mẫu; hãy đặt sample1..3.jpg vào $OUT." >&2; exit 1; }
    colors=(0x2d6cdf 0xe0603a 0x2fa36b)
    ffmpeg -y -v error -f lavfi -i "color=c=${colors[$((i-1))]}:s=1080x1080" -frames:v 1 -q:v 3 "$f"
  fi
done

# Chờ việc xong; in tiến độ; trả 0 nếu done.
wait_job() {
  local id="$1" waited=0 body status
  while [ "$waited" -lt "$MAX_WAIT" ]; do
    body=$(curl -fsS "${auth[@]}" "$URL/v1/jobs/$id")
    status=$(printf '%s' "$body" | json_field status)
    echo "   [$waited s] $body"
    case "$status" in
      done) return 0 ;;
      failed|cancelled) return 1 ;;
    esac
    sleep 5; waited=$((waited + 5))
  done
  echo "Quá $MAX_WAIT giây mà việc chưa xong." >&2; return 1
}

echo "== 3. Việc từ mẫu (product-slideshow, 1:1)"
spec='{"template":{"id":"product-slideshow","aspect":"1:1","variables":{"title":"Thử nghiệm máy chủ render","price":"199.000đ","cta":"Nhắn tin đặt ngay"},"images":["sample1.jpg","sample2.jpg","sample3.jpg"]}}'
resp=$(curl -fsS "${auth[@]}" -F "spec=$spec" -F "files=@$OUT/sample1.jpg" -F "files=@$OUT/sample2.jpg" -F "files=@$OUT/sample3.jpg" "$URL/v1/jobs")
echo "$resp"
job=$(printf '%s' "$resp" | json_field jobId)
[ -n "$job" ] || { echo "Không nhận được jobId." >&2; exit 1; }
wait_job "$job" || { echo "Việc mẫu thất bại." >&2; exit 1; }
curl -fsS "${auth[@]}" -o "$OUT/template.mp4" "$URL/v1/jobs/$job/video"
curl -fsS "${auth[@]}" -o "$OUT/template.jpg" "$URL/v1/jobs/$job/thumb"
echo "   Đã tải $OUT/template.mp4 ($(wc -c < "$OUT/template.mp4") byte)"

echo "== 4. HTML \"xấu\" (gọi mạng, đọc file://, leo thư mục)"
# Một dòng, chỉ dùng nháy đơn để nhúng thẳng vào JSON. Trang tự ghi kết quả thử lên hình.
html="<!doctype html><html><head><meta charset='UTF-8'><style>body{margin:0;width:1080px;height:1080px;background:#222;color:#fff;font:40px sans-serif}</style></head><body><div id='root' data-composition-id='main' data-start='0' data-duration='3' data-width='1080' data-height='1080'><div class='clip' data-start='0' data-duration='3' data-track-index='0'><p id='net'>net: pending</p><p id='file'>file: pending</p><p id='loc'>loc: pending</p><img src='https://example.com/x.png' width='100' height='100'><iframe src='file:///etc/hostname' width='900' height='120' style='background:#fff'></iframe><iframe src='http://169.254.169.254/latest/meta-data/' width='900' height='120' style='background:#fff'></iframe></div></div><script>fetch('https://example.com/').then(function(r){document.getElementById('net').textContent='net: LEAK '+r.status}).catch(function(e){document.getElementById('net').textContent='net: BLOCKED'});fetch('/..%2f..%2f..%2f..%2fetc%2fpasswd').then(function(r){return r.text()}).then(function(t){document.getElementById('loc').textContent='loc: '+t.slice(0,40)}).catch(function(){document.getElementById('loc').textContent='loc: BLOCKED'});fetch('file:///etc/passwd').then(function(r){return r.text()}).then(function(t){document.getElementById('file').textContent='file: LEAK '+t.slice(0,30)}).catch(function(){document.getElementById('file').textContent='file: BLOCKED'});window.__timelines={main:{duration:function(){return 3},seek:function(){},time:function(){return 0},pause:function(){}}};</script></body></html>"
resp=$(curl -fsS "${auth[@]}" -F "spec={\"html\":\"$html\",\"width\":1080,\"height\":1080}" "$URL/v1/jobs")
echo "$resp"
evil=$(printf '%s' "$resp" | json_field jobId)
[ -n "$evil" ] || { echo "Không nhận được jobId của việc HTML." >&2; exit 1; }
wait_job "$evil" || { echo "Việc HTML thất bại." >&2; exit 1; }
curl -fsS "${auth[@]}" -o "$OUT/evil.mp4" "$URL/v1/jobs/$evil/video"
echo "   HTML xấu đã render xong ($(wc -c < "$OUT/evil.mp4") byte): khu cách ly không làm hỏng việc."
if command -v ffmpeg >/dev/null; then
  ffmpeg -y -v error -ss 1.5 -i "$OUT/evil.mp4" -frames:v 1 "$OUT/evil.png"
  echo "   Khung hình kiểm tra: $OUT/evil.png"
  echo "   Mở ảnh: ba dòng net/file/loc phải là BLOCKED (hoặc trống), không được có chữ LEAK hay nội dung /etc/passwd."
fi

echo "== Xong. Tệp ở $OUT"
