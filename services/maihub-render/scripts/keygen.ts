import { generateKey } from '../src/keys';

const name = process.argv[2];
if (!name || !/^[A-Za-z0-9_.-]{1,40}$/.test(name)) {
  console.error('Cách dùng: npm run keygen -- <tên MaiHub>');
  process.exit(1);
}
const { raw, hash } = generateKey();
console.log(`Khoá gốc (đưa cho MaiHub "${name}", chỉ hiện một lần):\n${raw}\n`);
console.log('Thêm vào RENDER_API_KEYS trong .env của máy chủ:');
console.log(`"${name}":"${hash}"`);
