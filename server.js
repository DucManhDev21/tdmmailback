const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Multer lưu tệp tạm
const upload = multer({ dest: 'uploads/' });

// Mở CORS toàn bộ cho Frontend Vercel
app.use(cors({ origin: '*' }));
app.use(express.json());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Health check API
app.get('/api/health', (req, res) => {
  const senderEmail = process.env.SENDER_EMAIL;
  const appPassword = process.env.APP_PASSWORD;

  res.json({
    status: 'online',
    system: 'Trần Đức Mạnh Email Engine',
    envConfigured: Boolean(senderEmail && appPassword),
    senderEmail: senderEmail ? senderEmail.trim() : 'Chưa cấu hình SENDER_EMAIL trên Railway'
  });
});

// API Gửi Mail Hàng Loạt qua SSE (Server-Sent Events)
app.post('/api/send-emails', upload.array('attachments'), async (req, res) => {
  const { recipients, subject, bodyType, content, repeatCount } = req.body;
  const files = req.files || [];

  const senderEmail = process.env.SENDER_EMAIL;
  const appPassword = process.env.APP_PASSWORD;

  if (!senderEmail || !appPassword) {
    return res.status(500).json({
      success: false,
      message: 'Chưa cấu hình SENDER_EMAIL hoặc APP_PASSWORD trong Variables trên Railway!'
    });
  }

  if (!recipients || !subject || !content) {
    return res.status(400).json({ success: false, message: 'Vui lòng điền đầy đủ các thông tin!' });
  }

  const recipientList = recipients
    .split(/[\n,]+/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  if (recipientList.length === 0) {
    return res.status(400).json({ success: false, message: 'Danh sách email nhận không hợp lệ!' });
  }

  // Cấu hình Nodemailer chuẩn chống CONNECTION TIMEOUT trên Railway
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // STARTTLS
    auth: {
      user: senderEmail.trim(),
      pass: appPassword.replace(/\s+/g, ''), // Xóa khoảng trắng thừa
    },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    tls: {
      rejectUnauthorized: false
    }
  });

  const attachments = files.map((file) => ({
    filename: file.originalname,
    path: file.path,
  }));

  // Thiết lập SSE Headers chống NGINX/Vercel buffering
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Gửi Ping Keep-Alive mỗi 3s giữ kết nối Vercel-Railway không bị timeout
  const keepAliveInterval = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 3000);

  const totalSends = parseInt(repeatCount, 10) || 1;
  const totalTasks = totalSends * recipientList.length;
  let currentTaskIndex = 0;
  let totalSuccess = 0;
  let totalFailed = 0;

  try {
    await transporter.verify();
    res.write(`data: ${JSON.stringify({ type: 'info', message: `✅ Xác thực SMTP (${senderEmail.trim()}) thành công!` })}\n\n`);
  } catch (error) {
    clearInterval(keepAliveInterval);
    res.write(`data: ${JSON.stringify({ type: 'error', message: `❌ Kết nối Gmail thất bại: ${error.message}` })}\n\n`);
    attachments.forEach((f) => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    return res.end();
  }

  // Vòng lặp gửi email
  for (let cycle = 1; cycle <= totalSends; cycle++) {
    for (let index = 0; index < recipientList.length; index++) {
      const email = recipientList[index];
      currentTaskIndex++;

      const mailOptions = {
        from: `"Trần Đức Mạnh Mailer" <${senderEmail.trim()}>`,
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

      const isLast = cycle === totalSends && index === recipientList.length - 1;
      if (!isLast) {
        res.write(`data: ${JSON.stringify({ type: 'delay', seconds: 15 })}\n\n`);
        await sleep(15000);
      }
    }
  }

  clearInterval(keepAliveInterval);
  attachments.forEach((f) => {
    if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
  });

  res.write(`data: ${JSON.stringify({ type: 'done', message: '🎉 Đã hoàn thành toàn bộ chiến dịch gửi email!' })}\n\n`);
  res.end();
});

app.listen(PORT, () => {
  console.log(`🚀 TDM Backend running on port ${PORT}`);
});
