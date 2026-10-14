# Fixture chỉ dùng cho test

`cert.pem` và `key.pem` là chứng chỉ tự ký TEST-ONLY (CN=maihub-test), không phải bí mật và không dùng ở bất kỳ môi trường thật nào. Tạo lại:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=maihub-test -keyout key.pem -out cert.pem
```

Test tự tính dấu vân tay từ `cert.pem`, nên thay tệp không cần sửa test.
