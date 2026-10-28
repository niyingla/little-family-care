const cloud = require('wx-server-sdk');
const { runtime } = require('./lib/cloud.cjs');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * 家庭请求入口；身份只取微信上下文，不接受客户端指定OPENID。
 * @param {object} event 小程序发起的白名单操作和业务参数。
 * @returns {Promise<object>} 结构化业务结果；内部异常仅返回通用错误。
 */
exports.main = async (event) => {
  const started = Date.now();
  const openid = cloud.getWXContext().OPENID;
  const action = (event && event.action) || '';
  const { service, repo, hash } = runtime(cloud);
  try {
    let data;
    if (action === 'uploadAvatar') {
      const home = await service.readMember(openid);
      if (home.ownerId !== hash(openid).slice(0, 32))
        throw new Error('仅家庭管理员可以修改宝宝头像');
      const encoded = String((event.data && event.data.base64) || '');
      if (encoded.length > 1400000 || !/^[a-zA-Z0-9+/=]+$/.test(encoded))
        throw new Error('图片过大或格式不正确，请选1MB以内图片');
      const buffer = Buffer.from(encoded, 'base64');
      const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
      const png = buffer.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if ((!jpeg && !png) || buffer.length > 1024 * 1024)
        throw new Error('请使用1MB以内的JPG或PNG图片');
      // 通过服务端上传到私有存储；不开放客户端任意文件写入权限。
      const uploaded = await cloud.uploadFile({
        cloudPath: `avatars/${home.ownerId}/${require('node:crypto').randomBytes(16).toString('hex')}.${jpeg ? 'jpg' : 'png'}`,
        fileContent: buffer,
      });
      await repo.put('care_files', hash(uploaded.fileID), {
        ownerId: home.ownerId,
        fileID: uploaded.fileID,
      });
      data = { fileID: uploaded.fileID, message: '头像已上传' };
    } else {
      data = await service.call(openid, action, event.data || {});
      if (action === 'snapshot') {
        const ids = data.home.babies.map((b) => b.avatar).filter(Boolean);
        // 临时地址只在通过家庭权限检查后签发，存储保持私有。
        if (ids.length) {
          const files = await cloud.getTempFileURL({
            fileList: ids.map((fileID) => ({ fileID, maxAge: 600 })),
          });
          data.home.babies = data.home.babies.map((b) => ({
            ...b,
            avatarUrl:
              (files.fileList.find((f) => f.fileID === b.avatar && f.status === 0) || {})
                .tempFileURL || '',
          }));
        }
      }
    }
    console.info('家庭操作完成', { action, elapsedMs: Date.now() - started });
    return { ok: true, data };
  } catch (error) {
    // 日志记录操作和错误码，不打印微信身份、邀请token或图片内容。
    console.error('家庭操作失败', {
      action,
      code: error.errCode || error.code || 'BUSINESS',
      elapsedMs: Date.now() - started,
    });
    const internal =
      error.errCode ||
      error.code ||
      /database|cloud\.|collection|transaction|env/i.test(error.message || '');
    return {
      ok: false,
      message: internal
        ? '云端暂时不可用，请检查部署配置后重试'
        : error.message || '操作失败，请稍后重试',
    };
  }
};
