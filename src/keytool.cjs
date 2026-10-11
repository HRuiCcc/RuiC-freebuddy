// 取出 WorkBuddy 的 at-rest 静态加密密钥（只走管道，不落盘）。
try {
  const binding = process._linkedBinding('electron_browser_workbuddy_storage');
  const payload = JSON.parse(binding.loggerGet());
  if (!payload || payload.version !== 1 || typeof payload.atRestSecretKey !== 'string') {
    console.log('FBKEY_ERR ' + Buffer.from('schema mismatch').toString('base64'));
    process.exit(4);
  }
  console.log('FBKEY ' + Buffer.from(JSON.stringify({ version: payload.version, key: payload.atRestSecretKey })).toString('base64'));
  process.exit(0);
} catch (e) {
  console.log('FBKEY_ERR ' + Buffer.from(String((e && e.message) || e)).toString('base64'));
  process.exit(3);
}
