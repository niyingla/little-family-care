/**
 * 将私有头像分段下载到小程序沙盒；避免公开图片域名及云托管响应大小限制。
 * @param {Function} request 统一传输入口，支持GET、Range及ArrayBuffer响应。
 * @param {object} platform 微信API对象，提供文件系统及USER_DATA_PATH。
 * @returns {Function} load(route)返回本地路径；load.pin(routes)替换最多9张当前预览保护集合。
 */
function createAvatarCache(request, platform) {
  // 缓存保存下载Promise，同一头像并发加载时共享一次私有下载请求。
  const cache = new Map();
  // 固定集合只代表当前预览批次，切换批次后旧图片重新参与LRU淘汰。
  let pinned = new Set();
  let capacityChanged = null,
    wakeCapacity = null;
  let initialized = false;
  const prefix = 'care-private-avatar-';
  // 下载中条目也占预算，不能通过删除进行中的Promise假装释放容量。
  const capacity = 20;
  // 单张头像最多两段，兼顾服务端大小限制与云托管单次响应限制。
  const maximum = 1024 * 1024,
    partSize = 512 * 1024;
  /**
   * 首次使用时清理上一次页面会话留下的私有头像缓存。
   * @param {object} fs 微信文件系统管理器，只操作本应用沙盒目录。
   * @returns {void} 当前缓存实例清理完成；后续调用不重复扫描。
   * @throws {Error} 沙盒目录不可读时交由当前头像加载失败边界处理。
   */
  function prepare(fs) {
    // 实例内仅扫描一次，避免后续头像加载误删本次仍在使用的文件。
    if (initialized) return;
    // 只清理本模块生成且命名严格匹配的缓存，不触碰用户其他沙盒文件。
    const files = fs.readdirSync(platform.env.USER_DATA_PATH);
    for (const file of files)
      if (/^care-private-avatar-[a-f0-9]{32}\.(png|jpg)$/.test(file)) {
        try {
          fs.unlinkSync(platform.env.USER_DATA_PATH + '/' + file);
        } catch (_) {
          /* 已被系统回收的缓存无需再次删除。 */
        }
      }
    initialized = true;
  }
  /**
   * 下载并验证私有头像的一段连续字节。
   * @param {string} route 已带短时授权签名的私有头像路由。
   * @param {number} start 期望字节段的起点，包含该位置且从0开始。
   * @param {number} end 本次允许返回的最大字节位置，包含该位置。
   * @returns {Promise<object>} 验证通过的bytes及服务端声明的total。
   * @throws {Error} 网络失败、非206响应或分段完整性校验失败时拒绝使用。
   */
  async function readPart(route, start, end) {
    // 保留调用方私有路由的签名，不另建可绕过授权的公开图片请求。
    const response = await request(route, undefined, '', {
      method: 'GET',
      responseType: 'arraybuffer',
      header: { Range: `bytes=${start}-${end}` },
    });
    // HTTP响应头大小写不固定，不能因代理改写头名而跳过范围校验。
    const headers = response.header || {};
    const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-range');
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers[key] || '');
    // 按原始二进制验证长度，避免字符串编码转换破坏头像内容。
    const bytes = new Uint8Array(response.data);
    // 校验段起点、总长度和实际字节数，拒绝拼接截断或异常扩大的图片。
    if (
      response.statusCode !== 206 ||
      !range ||
      Number(range[1]) !== start ||
      Number(range[2]) > end ||
      Number(range[3]) > maximum ||
      bytes.length !== Number(range[2]) - start + 1
    )
      throw new Error('图片未完整下载，请稍后重试');
    // 仅将已验证的段暴露给组装逻辑，完整图片长度由后续段再次核对。
    return { bytes, total: Number(range[3]) };
  }
  /**
   * 从私有资源路由提取允许用于沙盒文件名的随机标识。
   * @param {string} route 带授权查询参数的/api/avatar相对路由。
   * @returns {string} 32位十六进制标识及允许的图片扩展名。
   * @throws {Error} 路由格式不合法时拒绝，不允许任意路径进入文件清理。
   */
  function filenameFor(route) {
    // 只接受应用生成的随机文件名，禁止把任意路由作为本地文件路径。
    const match = /^\/api\/avatar\/([a-f0-9]{32}\.(png|jpg))\?/.exec(route || '');
    if (!match) throw new Error('图片地址不正确');
    return match[1];
  }
  /**
   * 等待下载完成、失败或预览集合更换后重新检查缓存容量。
   * @returns {Promise<void>} 所有等待者共享本轮容量变化通知。
   */
  function waitForCapacity() {
    // 一轮等待只保存一个Promise，避免为同一容量事件持续创建通知对象。
    if (!capacityChanged)
      capacityChanged = new Promise((resolve) => {
        wakeCapacity = resolve;
      });
    return capacityChanged;
  }
  /**
   * 唤醒容量等待者，下一轮重新判断缓存而不预先分配名额。
   * @returns {void} 没有等待者时不产生额外异步任务。
   */
  function signalCapacity() {
    // 先重置本轮通知，唤醒后仍无容量的请求可以安全订阅下一次变化。
    const wake = wakeCapacity;
    capacityChanged = null;
    wakeCapacity = null;
    // 等待者醒来后竞争重新检查，不能把同一个空位同时分给多个下载。
    if (wake) wake();
  }
  /**
   * 按真正LRU顺序淘汰一个已经完成且不属于当前预览的文件。
   * @param {object} fs 微信沙盒文件管理器，只删除本缓存生成的合法文件名。
   * @returns {boolean} 已释放一个条目返回true，无可淘汰项时返回false。
   */
  function evictOne(fs) {
    // Map顺序在每次命中时刷新，最前面的可淘汰项才是真正最久未使用项。
    for (const [filename, entry] of cache) {
      // 下载未结束不能删除Promise；正在预览的九图批次也不能因封面加载丢失。
      if (!entry.complete || pinned.has(filename)) continue;
      cache.delete(filename);
      try {
        // filename只来自严格路由校验，不从远端响应或任意用户路径执行删除。
        fs.unlinkSync(platform.env.USER_DATA_PATH + '/' + prefix + filename);
      } catch (_) {
        // 已被系统回收的缓存不妨碍腾出内存条目，后续命中会重新下载。
      }
      return true;
    }
    // 全部条目仍在下载或被保护时必须等待，不能以扩大预算绕过限制。
    return false;
  }
  /**
   * 下载并完整写入一个已验证文件名对应的私有图片。
   * @param {string} route 带授权签名的私有路由，不写日志或公开缓存地址。
   * @param {string} filename filenameFor验证过的随机文件名。
   * @returns {Promise<string>} 完整图片在微信沙盒中的路径。
   * @throws {Error} 分段校验或沙盒写入失败时拒绝返回可预览路径。
   */
  async function download(route, filename) {
    // 写入前先清理旧会话缓存，私有头像不会无限跨会话积留。
    const fs = platform.getFileSystemManager();
    prepare(fs);
    const first = await readPart(route, 0, partSize - 1);
    // 首段已限制总大小，按声明总长分配一次连续缓冲区。
    const content = new Uint8Array(first.total);
    content.set(first.bytes);
    if (first.bytes.length < first.total) {
      // 后段必须延续首段范围且总长一致，不能把两次不同内容拼成可预览图片。
      const second = await readPart(route, first.bytes.length, first.total - 1);
      if (second.total !== first.total || first.bytes.length + second.bytes.length !== first.total)
        throw new Error('图片未完整下载，请稍后重试');
      content.set(second.bytes, first.bytes.length);
    }
    // 只在完整校验后落盘，失败的分段不会留下被当作成功缓存的图片。
    const filePath = platform.env.USER_DATA_PATH + '/' + prefix + filename;
    await new Promise((resolve, reject) =>
      fs.writeFile({ filePath, data: content.buffer, success: resolve, fail: reject })
    );
    // 容量在下载开始前已预留，写盘完成不再淘汰本次刚返回的预览图片。
    return filePath;
  }
  /**
   * 将授权图片下载到沙盒，命中更新LRU顺序并共享进行中的下载。
   * @param {string} route 符合私有头像路由格式且带授权查询参数的地址。
   * @returns {Promise<string>} 可交给image或previewImage的本地文件路径。
   * @throws {Error} 路由、下载完整性或本地文件写入失败时拒绝加载。
   */
  async function load(route) {
    const filename = filenameFor(route);
    // 先预留不超过20项的容量；未完成请求不可被其他新封面挤出缓存。
    while (!cache.has(filename) && cache.size >= capacity) {
      // 有可清理文件时先腾出一个名额，禁止先启动下载再事后删除别人的Promise。
      if (evictOne(platform.getFileSystemManager())) continue;
      // 唤醒不代表获得名额；下一轮还需检查是否被其他请求占用或已下载同图。
      await waitForCapacity();
    }
    if (cache.has(filename)) {
      // 命中包括尚未完成的请求，移到队尾后仍复用原Promise，避免重复写文件。
      const entry = cache.get(filename);
      cache.delete(filename);
      cache.set(filename, entry);
      return entry.promise;
    }
    // 先登记进行中条目再启动异步下载，并发同文件请求能立即找到这次Promise。
    // 登记与Promise赋值之间没有await，同文件不会读到尚未就绪的占位条目。
    const entry = { complete: false, promise: null };
    cache.set(filename, entry);
    entry.promise = download(route, filename)
      .then((filePath) => {
        // 只有写盘成功的项才可被LRU淘汰，随后通知等待者重新检查容量。
        entry.complete = true;
        signalCapacity();
        return filePath;
      })
      .catch((error) => {
        // 失败不永久缓存拒绝的Promise，释放名额供后续重试及其他图片使用。
        cache.delete(filename);
        signalCapacity();
        throw error;
      });
    return entry.promise;
  }
  /**
   * 原子替换当前预览批次的保护集合，不累积上一批图片。
   * @param {string[]} routes 最多9条合法私有路由；空数组用于解除当前保护。
   * @returns {void} 完整校验后替换保护集合，调用方应在并发load之前调用。
   * @throws {Error} 不是数组、超过9张或任一路由不合法时保留原保护集合。
   */
  load.pin = function pin(routes) {
    // 先校验整批再替换，坏路由不能导致前半批保护生效、后半批丢失。
    if (!Array.isArray(routes) || routes.length > 9) throw new Error('一次最多预览9张图片');
    const next = new Set(routes.map(filenameFor));
    pinned = next;
    // 切换批次后旧预览可参与淘汰，唤醒此前因容量保护而等待的封面下载。
    signalCapacity();
  };
  return load;
}
module.exports = { createAvatarCache };
