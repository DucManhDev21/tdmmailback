const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Cấu hình Multer để lưu file đính kèm tạm thời
const upload = multer({ dest: 'uploads/' });

// Mở CORS cho Frontend Vercel
app.use(cors({ origin: '*' }));
app.use(express.json());

// Hàm hỗ trợ Delay
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// API Kiểm tra trạng thái Server & Cấu hình Env
app.get('/api/health', (req, res) => {
  const senderEmail = process.env.SENDER_EMAIL;
  const appPassword = process.env.APP_PASSWORD;

  res.json({
    status: 'online',
    system: 'Trần Đức Mạnh Bulk Email Engine',
    envConfigured: Boolean(senderEmail && appPassword),
    senderEmail: senderEmail ? senderEmail : 'Chưa cấu hình SENDER_EMAIL trên Railway'
  });
});

// API Gửi Mail Hàng Loạt qua SSE (Server-Sent Events)
app.post('/api/send-emails', upload.array('attachments'), async (req, res) => {
  const { recipients, subject, bodyType, content, repeatCount } = req.body;
  const files = req.files || [];

  // Lấy Email gửi và Mật khẩu ứng dụng từ biến môi trường Railway
  const senderEmail = process.env.SENDER_EMAIL;
  const appPassword = process.env.APP_PASSWORD;

  if (!senderEmail || !appPassword) {
    return res.status(500).json({
      success: false,
      message: 'Chưa cấu hình SENDER_EMAIL hoặc APP_PASSWORD trong Variables trên Railway!'
    });
  }

  if (!recipients || !subject || !content) {
    return res.status(400).json({ success: false, message: 'Vui lòng điền đầy đủ các thông tin bắt buộc!' });
  }

  // Phân tách danh sách email nhận
  const recipientList = recipients
    .split(/[\n,]+/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  if (recipientList.length === 0) {
    return res.status(400).json({ success: false, message: 'Danh sách email nhận không hợp lệ!' });
  }

  // Khởi tạo Transporter cho Nodemailer
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: senderEmail.trim(),
      pass: appPassword.replace(/\s+/g, ''), // Tự động xóa khoảng trắng nếu copy nhầm
    },
  });

  // Chuẩn bị tệp đính kèm
  const attachments = files.map((file) => ({
    filename: file.originalname,
    path: file.path,
  }));

  // Thiết lập SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const totalSends = parseInt(repeatCount, 10) || 1;
  const totalTasks = totalSends * recipientList.length;
  let currentTaskIndex = 0;
  let totalSuccess = 0;
  let totalFailed = 0;

  try {
    await transporter.verify();
    res.write(`data: ${JSON.stringify({ type: 'info', message: `✅ Xác thực SMTP (${senderEmail}) thành công!` })}\n\n`);
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: '❌ Kết nối Gmail thất bại! Hãy kiểm tra lại SENDER_EMAIL và APP_PASSWORD trên Railway.' })}\n\n`);
    attachments.forEach((f) => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    return res.end();
  }

  // Vòng lặp gửi email
  for (let cycle = 1; cycle <= totalSends; cycle++) {
    for (let index = 0; index < recipientList.length; index++) {
      const email = recipientList[index];
      currentTaskIndex++;

      const mailOptions = {
        from: `"Trần Đức Mạnh Mailer" <${senderEmail}>`,
        to: email,
        subject: subject,
        [bodyType === 'html' ? 'html' : 'text']: content,
        attachments: attachments,
      };

      try {
        await transporter.sendMail(mailOptions);
        totalSuccess++;
        res.write(
          `data: ${JSON.stringify({
            type: 'log',
            status: 'success',
            message: `[Lần ${cycle}/${totalSends}] Gửi THÀNH CÔNG -> ${email}`,
            stats: { totalSuccess, totalFailed, currentTaskIndex, totalTasks },
          })}\n\n`
        );
      } catch (err) {
        totalFailed++;
        res.write(
          `data: ${JSON.stringify({
            type: 'log',
            status: 'error',
            message: `[Lần ${cycle}/${totalSends}] Gửi THẤT BẠI -> ${email}:${err.message}`,
            stats: { totalSuccess, totalFailed, currentTaskIndex, totalTasks },
          })}\n\n`
        );
      }

      // Delay cố định 15s giữa các mail
      const isLast = cycle === totalSends && index === recipientList.length - 1;
      if (!isLast) {
        res.write(`data: ${JSON.stringify({ type: 'delay', seconds: 15 })}\n\n`);
        await sleep(15000);
      }
    }
  }

  // Dọn dẹp file tạm
  attachments.forEach((f) => {
    if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
  });

  res.write(`data: ${JSON.stringify({ type: 'done', message: '🎉 Đã hoàn thành toàn bộ chiến dịch gửi email!' })}\n\n`);
  res.end();
});

app.listen(PORT, () => {
  console.log(`🚀 TDM Email Backend running on port ${PORT}`);
});
