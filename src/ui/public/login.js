// Trang đăng nhập khi mở giao diện từ xa: nút "Đăng nhập bằng Google" (Google Identity Services).
// Mã Google trả về được gửi lên /api/login; máy chủ kiểm tra chữ ký, ghi lại Gmail và mở phiên nếu được phép.

const msg = document.getElementById('msg');

function show(text, kind = '') {
  msg.textContent = text;
  msg.className = `alert ${kind}`.trim();
  msg.hidden = false;
}

function waitForGoogle(timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (window.google?.accounts?.id) return resolve(window.google.accounts.id);
      if (Date.now() - started > timeoutMs) return reject(new Error('Không tải được nút đăng nhập Google. Kiểm tra mạng rồi tải lại trang.'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function onCredential({ credential }) {
  show('Đang kiểm tra tài khoản…', 'info');
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      location.replace('/');
      return;
    }
    show(data.error || 'Không đăng nhập được.', data.status === 'pending' ? 'warn' : '');
  } catch {
    show('Không kết nối được máy chủ. Máy chạy tool có thể đang tắt.');
  }
}

async function start() {
  try {
    const { clientId } = await (await fetch('/api/login-config')).json();
    if (!clientId) {
      show('Chưa bật đăng nhập Google (thiếu ui.googleClientId trong config.json).');
      return;
    }
    const gsi = await waitForGoogle();
    gsi.initialize({ client_id: clientId, callback: onCredential, ux_mode: 'popup', auto_select: false });
    const light = document.documentElement.dataset.theme === 'light';
    gsi.renderButton(document.getElementById('gsi-btn'), {
      theme: light ? 'outline' : 'filled_black',
      size: 'large',
      shape: 'pill',
      text: 'signin_with',
      locale: 'vi',
      width: 280,
    });
  } catch (err) {
    show(err.message);
  }
}

start();
