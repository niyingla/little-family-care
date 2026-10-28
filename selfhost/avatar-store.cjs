const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * 创建头像存储；云托管使用阿里云数据库，自建服务保留本机文件兼容。
 * @param {object} options repo业务仓库、directory本机头像目录、mode存储模式。
 * @returns {object} write(filename,buffer)与read(filename)，不暴露公开存储桶。
 */
function createAvatarStore({ repo, directory, mode }) {
  // 数据库存储与容器生命周期解耦，读取权限仍由调用方HTTP入口负责。
  if (mode === 'database')
    return {
      // 数据库头像文档仅由私有接口访问，不向客户端返回底层存储地址。
      /**
       * 将头像二进制持久化为私有文档。
       * @param {string} filename HTTP入口已经校验的头像文件名。
       * @param {Buffer} buffer 已校验格式与大小的头像内容。
       * @returns {Promise<void>} 私有头像写入完成后结束。
       * @throws {Error} 数据库写入失败时向上传入口传播。
       */
      async write(filename, buffer) {
        // 小家庭头像上限1MB，和权限元数据一起持久存放，容器重建不会丢失。
        await repo.put('care_avatar_blobs', filename, { base64: buffer.toString('base64') });
      },
      /**
       * 从私有仓库读取一个头像。
       * @param {string} filename HTTP入口已经验证访问权限的头像文件名。
       * @returns {Promise<Buffer>} 供授权响应返回的二进制头像。
       * @throws {Error} 头像不存在时携带404状态；仓库异常继续向上传播。
       */
      async read(filename) {
        const item = await repo.get('care_avatar_blobs', filename);
        if (!item) throw Object.assign(new Error('图片暂时不可用'), { status: 404 });
        // 文件类型和访问签名由HTTP入口在读取前验证。
        return Buffer.from(item.base64, 'base64');
      },
    };
  // 文件模式依赖调用方校验文件名与授权，存储层不生成公开资源URL。
  return {
    /**
     * 以仅当前用户可读写的权限保存本机头像。
     * @param {string} filename HTTP入口已经校验且不含路径跳转的文件名。
     * @param {Buffer} buffer 已通过格式与大小校验的头像二进制。
     * @returns {Promise<void>} 新文件完整写入后结束。
     * @throws {Error} 文件已存在或磁盘不可写时拒绝写入。
     */
    async write(filename, buffer) {
      // 沿用本机文件模式，方便迁回阿里云或在已有环境回滚。
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      // 排他创建防止覆盖已有头像，目录与文件权限限制同机其他用户读取。
      await fs.writeFile(path.join(directory, filename), buffer, { mode: 0o600, flag: 'wx' });
    },
    read: (filename) => fs.readFile(path.join(directory, filename)),
  };
}
module.exports = { createAvatarStore };
