// eslint-disable-next-line @typescript-eslint/no-var-requires
const { stripConsoleFromCode } = require('../../../scripts/strip-console.js');

describe('strip-console', () => {
    it('giữ nguyên câu lệnh khi console.* là thân của if không có ngoặc', () => {
        const out = stripConsoleFromCode('if (bad) console.error("x", err);\nthrow new Error("y");');
        expect(out).not.toMatch(/console/);
        // thân if phải còn là một câu lệnh, nếu không `throw` sẽ bị nuốt vào điều kiện
        expect(() => new Function(`const bad = false, err = 1; ${out}`)).not.toThrow();
        expect(() => new Function(`const bad = false, err = 1; ${out}`)()).toThrow('y');
    });

    it('xoá console.* đứng riêng', () => {
        expect(stripConsoleFromCode('a(); console.log("hi"); b();')).not.toMatch(/console/);
    });

    it('không thêm void 0 khi lời gọi không kết thúc bằng dấu chấm phẩy', () => {
        expect(stripConsoleFromCode('const f = (m) => console.warn(m)')).toBe('const f = (m) => /* [stripped] */');
    });
});
