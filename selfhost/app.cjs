const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createService } = require('../server/service.cjs');
const { createWechat } = require('./wechat.cjs');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomId = () => crypto.randomBytes(16).toString('hex');
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};

async function readBody(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1500000) fail('请求内容过大', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (_) {
    fail('请求格式不正确');
  }
}

/**
 * 创建服务器模式HTTP入口，与云函数共用同一业务服务和规则。
 * @param {object} options repo、服务端config，可注入微信接口用于隔离外部测试。
 * @returns {object} HTTP server、定时tick和close方法。
 */
function createHttpApplication({ repo, config, wechat = createWechat(config) }) {
  if (!config.signingSecret || config.signingSecret.length < 32)
    throw new Error('签名密钥至少需要32字符');
  const fields = config.fields || {};
  const templateId = fields.task && fields.baby && fields.time ? config.templateId || '' : '';
  const service = createService(repo, {
    ownerOpenId: config.ownerOpenId || '',
    templateId,
    now: () => new Date().toISOString(),
    randomId,
    hash,
    sendMessage: (message) => wechat.sendMessage(message),
  });
  const avatarDirectory = path.join(config.dataDir, 'avatars');
  const sign = (filename, expires) =>
    crypto
      .createHmac('sha256', config.signingSecret)
      .update(`${filename}:${expires}`)
      .digest('hex');
  const avatarUrl = (filename) => {
    const expires = Date.now() + 600000;
    return `${config.publicOrigin}/api/avatar/${filename}?expires=${expires}&signature=${sign(filename, expires)}`;
  };
  const counters = new Map();
  function checkRate(request) {
    const address = request.socket.remoteAddress || 'unknown';
    const key = address;
    const time = Date.now(),
      entry = counters.get(key);
    if (!entry || entry.until < time) counters.set(key, { until: time + 60000, count: 1 });
    else if (++entry.count > 240) fail('请求过于频繁，请稍后再试', 429);
    // 限制匿名来源状态数量，避免外部扫描令内存持续增长。
    if (counters.size > 1000)
      for (const [id, record] of counters) if (record.until < time) counters.delete(id);
  }
  async function identity(request) {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '');
    if (!match) fail('登录已过期，请重新登录', 401);
    const session = await repo.get('care_sessions', hash(match[1]));
    if (!session || session.expiresAt < Date.now()) fail('登录已过期，请重新登录', 401);
    return session.openid;
  }
  async function uploadAvatar(openid, data) {
    const home = await service.readMember(openid);
    if (home.ownerId !== hash(openid).slice(0, 32)) fail('仅管理员可修改宝宝头像', 403);
    const base64 = String(data.base64 || '');
    if (base64.length > 1400000 || !/^[a-zA-Z0-9+/=]+$/.test(base64))
      fail('请上传1MB以内JPG或PNG头像');
    const buffer = Buffer.from(base64, 'base64');
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    const png = buffer.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if ((!jpeg && !png) || buffer.length > 1024 * 1024) fail('请上传1MB以内JPG或PNG头像');
    const filename = `${randomId()}.${jpeg ? 'jpg' : 'png'}`,
      fileID = `avatar:${filename}`;
    await fs.mkdir(avatarDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(avatarDirectory, filename), buffer, { mode: 0o600, flag: 'wx' });
    await repo.put('care_files', hash(fileID), { ownerId: home.ownerId, fileID });
    return { fileID, message: '头像已上传' };
  }
  async function serveAvatar(url, response) {
    const filename = url.pathname.slice('/api/avatar/'.length);
    const expires = Number(url.searchParams.get('expires')),
      signature = url.searchParams.get('signature') || '';
    if (
      !/^[a-f0-9]{32}\.(png|jpg)$/.test(filename) ||
      !Number.isSafeInteger(expires) ||
      expires < Date.now() ||
      expires > Date.now() + 600000 ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      fail('图片链接已失效', 403);
    // 文件名只允许服务端随机值，且签名长度固定后再做恒定时间比较。
    if (
      !crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(sign(filename, expires), 'hex')
      )
    )
      fail('图片链接已失效', 403);
    const data = await fs.readFile(path.join(avatarDirectory, filename));
    response.writeHead(200, {
      'content-type': filename.endsWith('.png') ? 'image/png' : 'image/jpeg',
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff',
    });
    response.end(data);
  }
  const send = (response, status, data) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(data));
  };
  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    let operation = 'unknown';
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        send(response, 200, {
          ok: true,
          service: 'little-family-care',
          wechatConfigured: !!(config.appId && config.appSecret),
        });
        return;
      }
      checkRate(request);
      if (request.method === 'GET' && url.pathname.startsWith('/api/avatar/')) {
        operation = 'avatar';
        await serveAvatar(url, response);
        return;
      }
      if (request.method !== 'POST') fail('接口不存在', 404);
      if (!String(request.headers['content-type'] || '').startsWith('application/json'))
        fail('请使用JSON请求');
      if (url.pathname === '/api/login') {
        operation = 'login';
        const data = await readBody(request);
        if (typeof data.code !== 'string' || data.code.length < 1 || data.code.length > 256)
          fail('微信登录凭证不正确');
        const user = await wechat.exchangeCode(data.code);
        const token = crypto.randomBytes(32).toString('hex');
        // 数据库仅存会话token的哈希，原值只在登录成功时给本人。
        await repo.put('care_sessions', hash(token), {
          openid: user.openid,
          expiresAt: Date.now() + 7 * 86400000,
        });
        send(response, 200, { ok: true, data: { token } });
        return;
      }
      if (url.pathname !== '/api/call') fail('接口不存在', 404);
      const openid = await identity(request),
        payload = await readBody(request);
      const action = payload.action || '',
        data = payload.data || {};
      operation = /^[a-zA-Z]{1,24}$/.test(action) ? action : 'unknown';
      let result =
        action === 'uploadAvatar'
          ? await uploadAvatar(openid, data)
          : await service.call(openid, action, data);
      if (action === 'snapshot')
        result.home.babies = result.home.babies.map((b) => ({
          ...b,
          avatarUrl:
            b.avatar && /^avatar:[a-f0-9]{32}\.(png|jpg)$/.test(b.avatar)
              ? avatarUrl(b.avatar.slice(7))
              : '',
        }));
      send(response, 200, { ok: true, data: result });
    } catch (error) {
      const business = /^[\u4e00-\u9fff]/.test(error.message || '');
      const status = error.status || (business ? 400 : 500);
      // 不记录URL查询、微信code、会话token、OpenID和图片内容。
      console.warn('服务器请求失败', { operation, status, elapsedMs: Date.now() - started });
      if (!response.headersSent)
        send(response, status, {
          ok: false,
          message: business ? error.message : '服务器暂时不可用，请稍后重试',
        });
      else response.end();
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return {
    server,
    tick: () => service.tick(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
module.exports = { createHttpApplication };
