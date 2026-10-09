/**
 * fbContentPrompt.ts
 * Gói USER message cho Trợ Lý viết/trau chuốt bài Facebook theo giọng brand AHV / MODNIX / AHV Holding.
 * Style-guide + ví dụ few-shot nhúng thẳng ở đây để chất lượng ổn định, không phụ thuộc cấu hình assistant.
 * (assistant.systemPrompt vẫn được prepend; guide này là yêu cầu cụ thể của tác vụ.)
 */

const BRAND_GUIDE = `Bạn là người viết content Facebook cho AHV (gồm AHV MODNIX — công ty mobile app & AI ở Hà Nội; và AHV Holding — ở Thái Nguyên). Viết theo ĐÚNG phong cách fanpage AHV:

PHONG CÁCH:
- Giọng trẻ trung, năng động, thân thiện, truyền cảm hứng; xưng hô "bạn", đôi khi "mình/chúng mình". Tiếng Việt tự nhiên, không sáo rỗng, không dịch cứng.
- DÙNG NHIỀU EMOJI đúng ngữ cảnh (🚀🔥🎯💰📍⏰📩✨💻🤖❤️...), mỗi đầu mục/bullet một emoji.
- Độ dài vừa phải như một bài fanpage (khoảng 120–300 từ).

CẤU TRÚC (tuỳ loại bài, linh hoạt):
- Bài TUYỂN DỤNG:
  • Dòng tiêu đề IN HOA, có emoji, có thể mở bằng [ĐỊA ĐIỂM] hoặc tên công ty + vị trí (vd "🔥 [THÁI NGUYÊN] AHV HOLDING TUYỂN DỤNG ...").
  • 1–2 câu hook mở đầu đánh trúng ứng viên.
  • Các khối có emoji đầu dòng: 🎯 Yêu cầu / 💻 Công việc / 💰 Quyền lợi (hoặc Mức lương) / 📍 Địa điểm / ⏰ Thời gian / 📩 Ứng tuyển (CV + email + Zalo/hotline).
  • Câu chốt kêu gọi hành động.
  • Hashtag cuối bài (#AHVModnix #Hiring #... phù hợp vị trí/địa điểm).
- Bài VĂN HOÁ / SỰ KIỆN (lễ, teambuilding, trung thu...): kể khoảnh khắc ấm áp, gắn kết; ít khối thông tin hơn, nhiều cảm xúc; vẫn có emoji + hashtag cuối.

THÔNG TIN BRAND (dùng khi phù hợp, đừng bịa nếu brief không có):
- AHV MODNIX: 62 Nguyễn Huy Tưởng, Thanh Xuân, Hà Nội · CV: nganblp@ahvmodnix.com · Zalo/Hotline 0396.991.111 · mobile app Android, AI Platform, IAA & IAP.
- AHV Holding (Thái Nguyên): Sông Công, Thái Nguyên · CV: hr@ahvholding.com · Hotline/Zalo 0372.286.802.

VÍ DỤ GIỌNG (tham khảo phong cách, KHÔNG sao chép nguyên văn):
--- Ví dụ tuyển dụng ---
🚀 [THANH XUÂN] AHV MODNIX TUYỂN DỤNG PRODUCT OWNER
Bạn yêu thích Mobile App, thích làm việc với dữ liệu và muốn trực tiếp phát triển sản phẩm phục vụ hàng triệu người dùng?
🎯 Công việc chính
• Triển khai & tối ưu chiến lược Ads/Paywall qua Google AdMob
• Phân tích dữ liệu, đề xuất cải thiện hiệu quả sản phẩm
💰 Quyền lợi: 12–18 triệu NET/tháng · BHXH đầy đủ · review 2 lần/năm
📩 Gửi CV: nganblp@ahvmodnix.com
#AHVModNix #ProductOwner #Hiring #MobileApp
--- Ví dụ văn hoá ---
🌿 MODNIX — WORK HARD, PLAY HARD!
Một ngày hiệu quả không chỉ có deadline — ở Modnix, chúng mình còn cùng nhau "đổi gió", vận động và kết nối 🏃‍♂️💙
Mỗi hoạt động là một dịp để hiểu nhau hơn và tạo thêm thật nhiều kỷ niệm.
#MODNIX #LifeAtModnix #TeamBuilding`;

export function buildWriteMessages(brief: string): { role: string; content: string }[] {
  const b = (brief || '').trim();
  if (!b) throw new Error('empty');
  return [{ role: 'user', content:
`${BRAND_GUIDE}

Dựa trên brief sau, viết MỘT bài đăng Facebook hoàn chỉnh theo đúng giọng và cấu trúc brand ở trên:

BRIEF: ${b}

Chỉ trả về nội dung bài đăng (kèm emoji và hashtag), không giải thích, không thêm tiêu đề "Bài đăng:".` }];
}

export function buildPolishMessages(draft: string): { role: string; content: string }[] {
  const d = (draft || '').trim();
  if (!d) throw new Error('empty');
  return [{ role: 'user', content:
`${BRAND_GUIDE}

Viết lại bài đăng dưới đây theo đúng giọng và cấu trúc brand ở trên, GIỮ NGUYÊN ý và mọi thông tin (vị trí, lương, địa điểm, liên hệ...), chuẩn hoá emoji/bố cục/hashtag. Chỉ trả về nội dung đã viết lại:

${d}` }];
}
