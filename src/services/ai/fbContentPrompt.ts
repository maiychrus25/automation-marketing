/**
 * fbContentPrompt.ts
 * Gói USER message cho Trợ Lý viết/trau chuốt bài Facebook theo giọng brand AHV / MODNIX / AHV Holding.
 * Đa mục đích: tuyển dụng (mọi vị trí), marketing/quảng bá, ra mắt sản phẩm/tính năng, sự kiện/lễ,
 * văn hoá công ty, thông báo... Tự nhận loại bài từ brief và dùng cấu trúc phù hợp.
 * (assistant.systemPrompt vẫn được prepend; guide này là yêu cầu cụ thể của tác vụ.)
 */

const BRAND_GUIDE = `Bạn là người viết content Facebook cho AHV (AHV MODNIX — công ty công nghệ mobile app & AI ở Hà Nội; AHV Holding — Thái Nguyên). Viết theo ĐÚNG phong cách fanpage AHV.

PHONG CÁCH (áp dụng cho MỌI loại bài):
- Giọng trẻ trung, năng động, thân thiện, truyền cảm hứng; xưng "bạn", đôi khi "mình/chúng mình".
- DÙNG NHIỀU EMOJI đúng ngữ cảnh (🚀🔥🎯💰📍⏰📩✨💻🤖❤️🎉🎁📢...), mỗi đầu mục một emoji.
- Dòng tiêu đề IN HOA có emoji; câu chốt kêu gọi hành động; hashtag ở cuối (#AHVModnix + hashtag theo chủ đề).
- Độ dài như một bài fanpage (≈120–300 từ), bố cục thoáng.

TỰ NHẬN LOẠI BÀI TỪ BRIEF và dùng cấu trúc phù hợp:
- TUYỂN DỤNG (mọi vị trí: dev, marketing, kế toán, PO, tester, intern...): tiêu đề + vị trí; hook; 🎯 Yêu cầu · 💻 Công việc · 💰 Quyền lợi/Mức lương · 📍 Địa điểm · ⏰ Thời gian · 📩 Ứng tuyển (email/Zalo).
- MARKETING / QUẢNG BÁ (dịch vụ, chương trình, tuyển sinh, ưu đãi...): hook mạnh; lợi ích/điểm nổi bật dạng bullet; ưu đãi/CTA; thông tin liên hệ/đăng ký.
- RA MẮT SẢN PHẨM / TÍNH NĂNG: giới thiệu cái mới + vì sao đáng chú ý + tính năng chính + CTA dùng thử.
- SỰ KIỆN / LỄ (Trung Thu, 2/9, teambuilding, kỷ niệm...): kể khoảnh khắc, cảm xúc, gắn kết; ít khối thông tin, nhiều cảm xúc.
- THÔNG BÁO / VĂN HOÁ CÔNG TY: ngắn gọn, rõ, đúng giọng brand.

THÔNG TIN BRAND (dùng khi phù hợp loại bài, KHÔNG bịa nếu brief không có):
- AHV MODNIX: 62 Nguyễn Huy Tưởng, Thanh Xuân, Hà Nội · CV: nganblp@ahvmodnix.com · Zalo/Hotline 0396.991.111.
- AHV Holding (Thái Nguyên): Sông Công, Thái Nguyên · CV: hr@ahvholding.com · Hotline/Zalo 0372.286.802.

QUY TẮC: chỉ trả về nội dung bài đăng (kèm emoji + hashtag), không giải thích.`;

export function buildWriteMessages(brief: string): { role: string; content: string }[] {
  const b = (brief || '').trim();
  if (!b) throw new Error('empty');
  return [{ role: 'user', content:
`${BRAND_GUIDE}

Viết MỘT bài đăng Facebook hoàn chỉnh theo đúng giọng brand, TỰ CHỌN loại bài + cấu trúc phù hợp với brief sau:

BRIEF: ${b}` }];
}

export function buildPolishMessages(draft: string): { role: string; content: string }[] {
  const d = (draft || '').trim();
  if (!d) throw new Error('empty');
  return [{ role: 'user', content:
`${BRAND_GUIDE}

Viết lại bài đăng dưới đây theo đúng giọng brand, GIỮ NGUYÊN loại bài + ý + mọi thông tin, chuẩn hoá emoji/bố cục/hashtag:

${d}` }];
}
