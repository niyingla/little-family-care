const api = require('../../../utils/client');
const d = require('../../../utils/domain');
const { MAX_IMAGE_BYTES } = require('../../../utils/media-policy');

/**
 * 将界面选项转换为明确发布或浏览范围，家庭选项不作为虚拟宝宝提交。
 * @param {string} selection all、family或真实宝宝ID，仅来自当前选择器。
 * @returns {object} 服务端scope及babyId，家庭babyId明确为空。
 */
function wallTarget(selection) {
  // all只是浏览全集，family是家庭主体；两者都不能当作宝宝档案ID。
  if (selection === 'all') return { babyId: 'all' };
  return selection === 'family'
    ? { scope: 'family', babyId: '' }
    : { scope: 'baby', babyId: selection };
}

/**
 * 为照片动态生成北京时间展示及尚未加载的首图状态。
 * @param {object} post 后端已授权返回的动态和照片短链。
 * @returns {object} 带本地日期标签、空首图及完整预览列表的展示副本。
 */
function displayPost(post) {
  // 日期与家庭事项保持北京时间，不能直接截取服务端UTC时间作为本地时间。
  return {
    ...post,
    timeLabel: `${d.chinaDate(post.createdAt)} ${d.chinaTime(post.createdAt)}`,
    // 元数据先展示，首图由有界队列补齐，不能用签名URL直接当云托管图片地址。
    localImages: [],
    cover: '',
  };
}

/**
 * 从当前页面共享队列逐张加载首图，切换页面后的旧任务只结束不更新。
 * @param {object} page 原生页面实例，提供队列、generation与setData。
 * @returns {Promise<void>} 队列暂时清空后结束，单张失败保留可点击查看入口。
 */
async function drainCovers(page) {
  // 多个worker共享同一队列，取走任务后其他worker不能再次下载同一首图。
  while (page._wallCoverQueue.length) {
    const task = page._wallCoverQueue.shift();
    try {
      // 过期任务不占用下载额度；已经在途的任务返回后还会再次核对generation。
      if (task.generation !== page._wallGeneration || page.data.view !== 'photos') continue;
      const local = await api.loadPrivateImage(task.url);
      // 下载完成时用户可能已离开或换宝宝，不能只在发起前判断页面状态。
      if (!local || task.generation !== page._wallGeneration || page.data.view !== 'photos')
        continue;
      // 相同ID只更新当前仍显示的动态，不把旧筛选结果重新插入新页面。
      page.setData({
        wallPosts: page.data.wallPosts.map((post) =>
          post.id === task.id && post.babyId === task.babyId ? { ...post, cover: local } : post
        ),
      });
    } catch (_) {
      // 缩略图失败不影响文字和分页；主动点击时会重新鉴权并尝试加载整组。
    } finally {
      // 成功、取消和失败都唤醒本批等待者，单图故障不会把整页刷新永久挂起。
      task.resolve();
    }
  }
}

/**
 * 为整个页面维持最多三个首图下载worker，跨筛选请求共享并发上限。
 * @param {object} page 原生页面实例，持有待执行首图队列。
 * @returns {void} 后台运行worker，旧下载结束后再继续新筛选任务。
 */
function pumpCovers(page) {
  // 在途旧请求也计入三并发，切换筛选不会额外再启动三条下载。
  while ((page._wallCoverWorkers || 0) < 3 && page._wallCoverQueue.length) {
    // 启动前同步占用额度，多个元数据批次在同一轮排队也不会重复使用空余名额。
    page._wallCoverWorkers = (page._wallCoverWorkers || 0) + 1;
    void drainCovers(page).finally(() => {
      // worker与新元数据请求的结束顺序不固定，释放后再次检查队列防止遗漏。
      page._wallCoverWorkers--;
      pumpCovers(page);
    });
  }
}

module.exports = {
  /**
   * 为新照片墙标签选择独立加载流程，其余标签保留原事项控制器行为。
   * @param {object} event 导航事件，dataset.id为标签ID。
   * @returns {Promise<void>} 照片墙先显示元数据再补首图，其他页按原方式切换。
   */
  async navigateTab(event) {
    // 上传或发布尚未结束时不切换数据上下文，避免把照片归到另一位宝宝。
    if (this.data.busy || this.data.refreshing) return;
    if (event.currentTarget.dataset.id === 'photos') await this.openPhotoWall();
    // 原页面的日期、事项筛选与行为埋点仍通过原switchTab执行。
    else {
      this.cancelWallCovers();
      await this.switchTab(event);
    }
  },
  /**
   * 打开宝宝照片墙并根据当前授权宝宝生成浏览与发布选择器。
   * @returns {Promise<void>} 加载当前页文字与首图，不扩大到所有历史照片。
   */
  async openPhotoWall() {
    // 重入标签也使旧筛选请求失效，不能让旧页结果覆盖新的“全部照片”范围。
    this.cancelWallCovers();
    // 宝宝选项来自当前授权家庭快照，不读取家人设备相册或外部家庭资料。
    const babies = this.data.babies;
    // “全部照片”仅用于浏览，发布明确选择家庭日常或当前家庭的一位宝宝。
    const options = [
      { id: 'all', name: '全部照片' },
      { id: 'family', name: '家庭日常' },
      ...babies,
    ];
    const targets = [{ id: 'family', name: '家庭日常' }, ...babies];
    const draft = this.data.wallDraft || { babyId: '', text: '', photos: [] };
    const validDraft = targets.some((target) => target.id === draft.babyId);
    // 失效的宝宝不能沿用旧草稿；有效草稿在切换标签时保留，避免丢失输入。
    this.setData({
      view: 'photos',
      wallBabyOptions: options,
      wallComposerBabies: targets,
      // 每次重开从全家庭的最新动态开始，浏览筛选与待发布草稿彼此独立。
      wallBabyId: 'all',
      wallBabyIndex: 0,
      // 每次进入先浏览照片；草稿继续保留，用户主动展开后才恢复编辑界面。
      wallComposerOpen: false,
      wallComposerIndex: validDraft ? targets.findIndex((target) => target.id === draft.babyId) : 0,
      wallDraft: validDraft ? draft : { babyId: 'family', text: '', photos: [] },
    });
    // 真实动态加载与照片发布是独立动作，打开页面不会上传草稿或发送通知。
    await this.loadPhotoWall(true);
  },
  /**
   * 按用户意图展开照片发布区，不触发选图、上传或清空已有草稿。
   * @returns {void} 当前有可发布范围且未忙碌时，仅更新本地展开状态。
   */
  openWallComposer() {
    // 上传或发布期间不切换编辑状态；空范围也不能制造可提交的发布入口。
    if (this.data.busy || !this.data.wallComposerBabies.length) return;
    this.setData({ wallComposerOpen: true });
  },
  /**
   * 收起照片发布区，保留文字、已上传照片与当前发布范围。
   * @returns {void} 未忙碌时仅隐藏编辑界面，重新展开仍可继续本次草稿。
   */
  collapseWallComposer() {
    // 不清空草稿或删文件，收起只影响显示；正在提交时等待原操作结束。
    if (this.data.busy) return;
    this.setData({ wallComposerOpen: false });
  },
  /**
   * 加载照片墙的一页真实历史，筛选空页仍保留继续翻页的游标。
   * @param {boolean} reset 为true时重读最新页，false时使用下一待扫描节点。
   * @returns {Promise<void>} 成功合并动态；失败保留错误，权限失效时清空照片墙。
   */
  async loadPhotoWall(reset = true) {
    // 一页只保留一个请求，避免快速点击把同一游标的结果重复追加。
    if (this.data.wallLoading) return;
    if (this.data.demo) {
      // 体验不上传或伪造家庭照片，明确保留功能说明而不是模拟分享成功。
      this.setData({
        wallPosts: [],
        wallCursor: '',
        wallNotice: '连接家庭服务后，可以和家人分享宝宝照片。',
      });
      return;
    }
    const babyId = this.data.wallBabyId || 'all';
    if (!reset && !this.data.wallCursor) return;
    // 新查询让旧筛选尚未完成的首图失效，元数据返回也按同一generation校验。
    this.cancelWallCovers();
    const generation = this._wallGeneration;
    this.setData({ wallLoading: true, wallNotice: '' });
    try {
      // 只传宝宝筛选和可信服务端游标，不让界面猜测数据库分页偏移。
      const result = await api.call('listPhotoPosts', {
        ...wallTarget(babyId),
        cursor: reset ? '' : this.data.wallCursor,
        limit: 20,
      });
      if (generation !== this._wallGeneration || this.data.view !== 'photos') return;
      const existing = reset ? [] : this.data.wallPosts;
      const ids = new Set(existing.map((post) => post.id));
      // 软删或并发新发帖不会改变旧指针；额外去重保护界面免于重复请求追加。
      const added = result.posts.filter((post) => !ids.has(post.id)).map(displayPost);
      this.setData({ wallPosts: [...existing, ...added], wallCursor: result.nextCursor || '' });
      // 元数据先立即可见，释放分页锁后再补首图，慢图片不会锁住宝宝筛选。
      this.setData({ wallLoading: false });
      await this.loadWallCovers(added, generation);
    } catch (error) {
      // 已离开或切换筛选的旧请求即使失败，也不能把错误覆盖到新页面。
      if (generation !== this._wallGeneration || this.data.view !== 'photos') return;
      // 已离家的会话不能继续停留在缓存照片墙，即使登录令牌尚未到期。
      if (/无权/.test(error.message || ''))
        this.setData({ wallPosts: [], wallCursor: '', gate: true });
      this.setData({ wallNotice: error.message || '照片墙暂时加载失败，请下拉刷新重试。' });
    } finally {
      // 失败同样允许下拉重试或继续翻页，不把加载状态永久留在页面上。
      if (generation === this._wallGeneration) this.setData({ wallLoading: false });
    }
  },
  /**
   * 只为本次最多20条新动态各加载首图，完整九张集合仍由主动预览触发。
   * @param {Array<object>} posts 当前元数据页的动态列表，不包含此前全部历史。
   * @param {number} generation 发起本页元数据请求时的版本，切换后任务失效。
   * @returns {Promise<void>} 首图尝试结束；单张失败不阻止动态阅读或继续分页。
   */
  async loadWallCovers(posts, generation) {
    // 队列属于当前页面实例，跨翻页批次复用以统一约束并发数量。
    this._wallCoverQueue = this._wallCoverQueue || [];
    const completions = [];
    // 每条只排第一张图，最多20条；不能因一篇九图或累计翻页而无界预取。
    for (const post of posts.slice(0, 20)) {
      // 无有效照片的历史仍可读文字，不为其制造不存在的占位图片请求。
      if (!post.photos.length) continue;
      completions.push(
        new Promise((resolve) =>
          this._wallCoverQueue.push({
            // 首图任务与单条动态绑定，不把整组照片加入后台预取。
            id: post.id,
            babyId: post.babyId,
            url: post.photos[0].photoUrl,
            generation,
            // 取消和失败都要结束该任务等待，不让页面加载悬挂。
            resolve,
          })
        )
      );
    }
    // 每个任务携带动态和宝宝身份，回写只能补充仍在当前范围内的那条记录。
    // 所有批次复用同一组worker，旧请求尚在途时不会突破三个并发。
    pumpCovers(this);
    await Promise.all(completions);
  },
  /**
   * 页面隐藏、切换或新筛选时撤销尚未启动的首图任务。
   * @returns {void} 在途请求允许结束，但不能再覆盖当前筛选数据。
   */
  cancelWallCovers() {
    this._wallGeneration = (this._wallGeneration || 0) + 1;
    // 旧预览同时失效；新页面可以发起预览，旧请求结束时不得释放新请求的锁。
    this._wallPreviewing = null;
    // 清掉队列同时结束等待者，不能让旧loadPhotoWall永久挂起。
    for (const task of this._wallCoverQueue || []) task.resolve();
    this._wallCoverQueue = [];
    this.setData({ wallLoading: false });
  },
  /**
   * 根据当前封面加载结果记录原始宽高比，避免固定高度裁剪竖图。
   * @param {object} event image加载事件，detail含正数width/height，dataset含动态id与cover路径。
   * @returns {void} 仅更新仍在照片墙显示的同一封面比例，不读取或改写图片文件。
   */
  wallCoverLoaded(event) {
    // 离开页面或失去家庭访问权后，迟到的图片回调不再修改照片墙状态。
    if (this.data.view !== 'photos' || this.data.gate) return;
    const { id, cover } = event.currentTarget.dataset;
    const { width, height } = event.detail;
    // 原生组件必须给出有限正尺寸，错误解码不能制造无限高度或零高占位。
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    const ratio = height / width;
    const current = this.data.wallPosts.find((post) => post.id === id && post.cover === cover);
    // 动态ID与本地路径一起核对，旧封面回调不能覆盖已刷新图片的布局。
    if (!current || current.coverRatio === ratio) return;
    this.setData({
      wallPosts: this.data.wallPosts.map((post) =>
        post === current ? { ...post, coverRatio: ratio } : post
      ),
    });
  },
  /**
   * 沙盒缓存被淘汰或图片暂不可用时恢复可点击加载入口。
   * @param {object} event image错误事件，dataset.id为当前动态ID。
   * @returns {void} 不自动循环重试下载，避免错误图片反复消耗网络。
   */
  wallCoverError(event) {
    // 图片错误只清除本机展示路径，不能删除墙帖或服务端持久图片。
    const id = event.currentTarget.dataset.id;
    // 当前共用私有缓存容量有限，较早图片失效时允许点击重新加载整组。
    this.setData({
      wallPosts: this.data.wallPosts.map((post) =>
        post.id === id ? { ...post, cover: '', localImages: [] } : post
      ),
    });
  },
  /**
   * 按列表提供的下一节点加载更早动态。
   * @returns {Promise<void>} 没有游标或已有请求时不产生多余调用。
   */
  async loadMoreWall() {
    // 空筛选页仍可能有更老的匹配动态，因此只依据nextCursor判断历史是否结束。
    await this.loadPhotoWall(false);
  },
  /**
   * 修改浏览照片墙的宝宝范围，发布草稿不会随浏览筛选改变。
   * @param {object} event 选择器事件，detail.value为wallBabyOptions索引。
   * @returns {Promise<void>} 从选定宝宝的最新一页重新开始浏览。
   */
  async changeWallBaby(event) {
    if (this.data.wallLoading || this.data.busy) return;
    const index = Number(event.detail.value),
      baby = this.data.wallBabyOptions[index];
    // 使用当前授权选项取ID，不能把选择器文本当作任意宝宝参数。
    if (!Number.isInteger(index) || !baby) return;
    this.setData({ wallBabyId: baby.id, wallBabyIndex: index });
    // 旧范围游标不可继续沿用，否则会漏掉新宝宝筛选下较新的照片。
    await this.loadPhotoWall(true);
  },
  /**
   * 选择本次发布照片所属于的家庭日常或具体宝宝。
   * @param {object} event detail.value为当前授权宝宝选项索引。
   * @returns {void} 已上传草稿存在时拒绝换宝宝，防止照片归属与上传元数据不一致。
   */
  changeWallComposerBaby(event) {
    // 选图和发布正在进行时保持宝宝归属不变，上传元数据不能随手势漂移。
    if (this.data.busy) return;
    const index = Number(event.detail.value),
      baby = this.data.wallComposerBabies[index];
    // 发布包含独立家庭日常和当前真实宝宝，家庭选项不会写成宝宝档案ID。
    if (!Number.isInteger(index) || !baby) return;
    if (this.data.wallDraft.photos.length && baby.id !== this.data.wallDraft.babyId) {
      // 不能静默丢掉已经选好的照片，也不能将它们改挂到另一宝宝。
      wx.showToast({ title: '请先移除已选照片，再切换范围', icon: 'none' });
      return;
    }
    // 未上传照片时仅切换本地草稿，不向服务端修改任何已经发布的动态。
    this.setData({
      wallComposerIndex: index,
      wallDraft: { ...this.data.wallDraft, babyId: baby.id },
    });
  },
  /**
   * 保存用户主动填写的照片说明。
   * @param {object} event 文本输入事件，detail.value最多保留200个字符。
   * @returns {void} 只更新本地草稿，不上传输入过程或记录文字日志。
   */
  changeWallText(event) {
    if (this.data.busy) return;
    // 以字符而不是UTF16码元截断，表情不会被切成半个代理字符。
    const text = [...String(event.detail.value || '')].slice(0, 200).join('');
    this.setData({ wallDraft: { ...this.data.wallDraft, text } });
  },
  /**
   * 由用户主动选择照片并逐张上传，草稿最多保留九张。
   * @returns {Promise<void>} 取消不报错，部分上传失败时保留已成功的草稿照片。
   */
  async chooseWallPhotos() {
    // 同一时间只开放一个相册选择或上传流程，防止两批照片突破九张上限。
    if (this.data.busy || this.data.demo) return;
    const draft = this.data.wallDraft,
      remaining = 9 - draft.photos.length;
    // 先确定宝宝归属再开放相机或相册，避免上传后无处发布。
    if (!draft.babyId || remaining <= 0) return;
    this.setData({ busy: true, wallUploading: true });
    try {
      // 系统仅返回用户明确选择的照片，不遍历相册或读取其他私有路径。
      const selected = await wx.chooseMedia({
        count: remaining,
        mediaType: ['image'],
        sourceType: ['camera', 'album'],
        sizeType: ['compressed'],
      });
      const files = selected.tempFiles || [];
      // 先检查整批大小再逐张上传，最后一张超限不能造成前几张无意留在云端。
      if (files.length > remaining || files.some((file) => file.size > MAX_IMAGE_BYTES))
        throw new Error('每张照片需在10MB以内，每篇最多9张');
      for (const file of files) {
        const base64 = wx.getFileSystemManager().readFileSync(file.tempFilePath, 'base64');
        // 每张独立请求控制正文大小，不把九张照片编码塞入一次云托管调用。
        const result = await api.call('uploadWallPhoto', { ...wallTarget(draft.babyId), base64 });
        if (!result || !result.photoId) throw new Error('照片上传失败，请重试');
        // 只有持久化成功的照片才加入草稿；后续失败不抹掉本次已成功上传的照片。
        const photos = [
          ...this.data.wallDraft.photos,
          { photoId: result.photoId, path: file.tempFilePath },
        ];
        this.setData({ wallDraft: { ...this.data.wallDraft, photos } });
      }
    } catch (error) {
      // 用户取消保留原草稿，实际上传失败显示提示且不自动发布。
      if (!/cancel/i.test(error.errMsg || ''))
        wx.showToast({ title: error.message || '照片选择失败', icon: 'none' });
    } finally {
      // 上传与取消都释放全局提交锁，用户随后可以继续编辑文字或发布。
      this.setData({ busy: false, wallUploading: false });
    }
  },
  /**
   * 从本地发布草稿移除一张照片，不删除已发布记录或私有二进制。
   * @param {object} event dataset.index为草稿照片的0起始索引。
   * @returns {void} 只修改本次草稿，服务端再次验证最终发布集合。
   */
  removeWallDraftPhoto(event) {
    // 上传期间索引集合会变化，禁止并发移除导致最后回写把已移除照片带回。
    if (this.data.busy) return;
    const index = Number(event.currentTarget.dataset.index);
    // 索引必须对应当前草稿，过期点击不能误删另一张照片。
    if (!Number.isInteger(index) || index < 0 || index >= this.data.wallDraft.photos.length) return;
    // 仅丢弃本次发布引用，已上传文件不执行DELETE，也不影响历史帖子中的同一图片。
    this.setData({
      wallDraft: {
        ...this.data.wallDraft,
        photos: this.data.wallDraft.photos.filter((_, i) => i !== index),
      },
    });
  },
  /**
   * 发布当前照片与文字，服务端成功后才清空草稿。
   * @returns {Promise<void>} 失败保留照片与文字，成功刷新照片墙最新页。
   */
  async publishWallPost() {
    // 发布按钮共享全局提交锁，防止连点将同一份九图草稿发布成多篇。
    if (this.data.busy || this.data.demo) return;
    const draft = this.data.wallDraft;
    if (!draft.photos.length) return;
    // 明确发布成功之前保持编辑区展开，失败后可直接检查原草稿并重试。
    this.setData({ busy: true, wallComposerOpen: true });
    try {
      // 只提交照片标识和文字；发布者、时间及权限由服务端会话决定。
      const result = await api.call('publishPhotoPost', {
        ...wallTarget(draft.babyId),
        text: draft.text,
        photoIds: draft.photos.map((photo) => photo.photoId),
      });
      if (!result || !result.postId) throw new Error('照片未发布成功，请重试');
      // 上传成功不等于发布成功；仅在取得真实帖子ID后丢弃本地输入。
      this.setData({
        wallComposerOpen: false,
        wallDraft: { babyId: draft.babyId, text: '', photos: [] },
      });
      wx.showToast({ title: '家庭照片已发布', icon: 'none' });
      // 列表失败由加载方法独立提示，不能把已提交动态重新解释成发布失败再重发。
      await this.loadPhotoWall(true);
    } catch (error) {
      // 失败保留完整草稿，避免重选照片或重复上传；不显示虚假的分享成功。
      wx.showToast({ title: error.message || '发布失败，请稍后重试', icon: 'none' });
    } finally {
      this.setData({ busy: false });
    }
  },
  /**
   * 用户主动查看某篇动态时重新鉴权，再按需下载并预览照片。
   * @param {object} event dataset.id为动态ID，index为希望打开的照片位置。
   * @returns {Promise<void>} 仅对仍存在且有访问权的动态打开私有图片。
   */
  async previewWallPost(event) {
    const { id, index = 0 } = event.currentTarget.dataset;
    // 仅从当前授权动态中取帖子，按钮参数不允许直接携带任意文件URL。
    const post = this.data.wallPosts.find((item) => item.id === id);
    if (!post || this._wallPreviewing || this.data.view !== 'photos' || this.data.gate) return;
    // 一次只预览一组照片，连续点击不会重复下载同一整组私有文件。
    const token = {},
      generation = this._wallGeneration || 0;
    this._wallPreviewing = token;
    // 页面、成员资格与请求代次必须始终一致，单靠“仍有这条动态”不足以弹图。
    const active = () =>
      this.data.view === 'photos' &&
      !this.data.gate &&
      (this._wallGeneration || 0) === generation &&
      this._wallPreviewing === token;
    try {
      // 复用单条游标查询刷新十分钟短链，同时重新判断是否已被作者删除。
      const result = await api.call('listPhotoPosts', {
        scope: post.scope,
        babyId: post.babyId,
        cursor: id,
        limit: 1,
      });
      // 鉴权请求返回时用户可能已离开，不继续排队下载旧页面的整组照片。
      if (!active()) return;
      const current = result.posts.find((item) => item.id === id);
      if (!current || !current.photos.length) throw new Error('这篇动态已删除或照片暂不可查看');
      // 下载范围只限被点击这篇最多九张，不顺带预取当前页或历史的其他照片。
      // 批量入口先钉住本次最多九张预览文件，再使用有界并发下载，避免首张被淘汰。
      const urls = await api.loadPrivateImages(current.photos.map((photo) => photo.photoUrl));
      if (!active()) return;
      // 每张都拿到真实本地地址后才打开整组预览，不让空文件冒充照片加载成功。
      if (urls.some((url) => !url)) throw new Error('照片暂未完整加载，请重试');
      // 只在明确查看后显示本机缩略图，周期性家庭刷新不会下载整面照片墙。
      if (!active()) return;
      this.setData({
        wallPosts: this.data.wallPosts.map((item) =>
          item.id === id ? { ...item, localImages: urls } : item
        ),
      });
      // 回写与原生弹图分别守卫，即便状态在本机组件回调中变化也不弹出旧图。
      if (!active()) return;
      await wx.previewImage({ current: urls[Number(index)] || urls[0], urls });
      if (!active()) return;
    } catch (error) {
      // 不能把过期短链或未下载地址交给系统预览，也不能宣称失败的下载成功。
      if (active()) wx.showToast({ title: error.message || '照片暂时无法加载', icon: 'none' });
    } finally {
      // 只释放自己持有的锁，旧请求晚返回不能允许新预览期间重复点击。
      if (this._wallPreviewing === token) this._wallPreviewing = null;
    }
  },
  /**
   * 请求作者或真正管理员的删除权限，提交成功后才撤下页面动态。
   * @param {object} event dataset.id为当前展示的动态ID。
   * @returns {Promise<void>} 取消和失败保持原动态，成功仅移除墙帖展示。
   */
  async deleteWallPost(event) {
    if (this.data.busy) return;
    const id = event.currentTarget.dataset.id;
    const post = this.data.wallPosts.find((item) => item.id === id);
    // 按钮状态只用于交互提示，服务端还会重新校验当前作者或管理员身份。
    if (!post || !post.canDelete) return;
    // 用户确认的对象是墙帖，关联事项历史及照片二进制不在删除范围。
    const answer = await wx.showModal({
      title: '删除这篇照片动态？',
      content: '删除后不再显示在照片墙，事项执行历史仍保留。',
    });
    // 取消不消耗服务端请求，也不提前隐藏用户仍希望保留的动态。
    if (!answer.confirm) return;
    this.setData({ busy: true });
    try {
      await api.call('deletePhotoPost', { postId: id });
      // 请求失败前不做乐观删除，避免无权限时界面却伪装成操作成功。
      this.setData({ wallPosts: this.data.wallPosts.filter((item) => item.id !== id) });
      wx.showToast({ title: '照片动态已删除', icon: 'none' });
    } catch (error) {
      wx.showToast({ title: error.message || '删除失败，请重试', icon: 'none' });
    } finally {
      // 删除异常后释放提交锁，用户才能重试或继续浏览其他动态。
      this.setData({ busy: false });
    }
  },
};
