/* 图片上限由前后端共享，Base64长度按三字节编码四字符的边界向上取整。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
// 每块预留JSON元数据空间，避免大图触发云托管约100KB的请求包限制。
const UPLOAD_CHUNK_CHARACTERS = 64 * 1024;
const MAX_UPLOAD_PARTS = Math.ceil(MAX_BASE64_LENGTH / UPLOAD_CHUNK_CHARACTERS);

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_BASE64_LENGTH,
  UPLOAD_CHUNK_CHARACTERS,
  MAX_UPLOAD_PARTS,
};
