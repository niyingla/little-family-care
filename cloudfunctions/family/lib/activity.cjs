const { VIEWS, CLICKS } = require('./activity-policy');

/**
 * 创建不含表单内容的行为记录器；日志失败不影响已经提交的业务。
 * @param {object} options repo持久仓库、now服务端时间及randomId唯一ID生成器。
 * @returns {object} 服务端记录record和经过白名单校验的客户端批量记录client。
 */
function createActivityRecorder({ repo, now, randomId }) {
  // 时间和ID由服务端依赖提供，客户端不能伪造持久记录的来源身份。
  /**
   * 写入一条经过字段裁剪的服务端行为记录。
   * @param {object} event 服务端已确认身份、来源和业务结果的事件描述。
   * @returns {Promise<boolean>} 成功持久化返回true，日志存储异常返回false。
   */
  async function record(event) {
    const at = now();
    // 逐项组装，绝不把调用方提供的对象整体写入日志。
    const entry = {
      at,
      // 只保存内部操作者标识，事件不包含昵称、手机号或表单内容。
      actorId: event.actorId || '',
      kind: event.kind,
      name: event.name,
      source: event.source,
      outcome: event.outcome,
      // 视图限制在已知界面范围，不能把任意用户文本塞入页面维度。
      ...(VIEWS.includes(event.view) ? { view: event.view } : {}),
      // 耗时规范为有限非负整数，异常数值不进入统计结果。
      ...(Number.isFinite(event.durationMs)
        ? { durationMs: Math.max(0, Math.round(event.durationMs)) }
        : {}),
      // 错误只保留结构化代码，不持久化可能带隐私的异常消息或堆栈。
      ...(/^[A-Z0-9_]{1,64}$/.test(event.errorCode || '') ? { errorCode: event.errorCode } : {}),
      ...(Number.isInteger(event.wechatCode) ? { wechatCode: event.wechatCode } : {}),
    };
    try {
      // 时间加唯一ID允许同毫秒的多条交互并存，不覆盖已经记录的事件。
      await repo.put('care_activity', `${at}:${randomId()}`, entry);
      return true;
    } catch (_) {
      // 数据库异常可能包含SQL和连接信息，只记录固定诊断提示。
      console.warn('行为记录写入失败，业务结果保持不变');
      return false;
    }
  }
  /**
   * 校验并接收已登录客户端的一批白名单行为事件。
   * @param {string} actorId 鉴权入口确认的当前家庭成员标识，不信任请求自报身份。
   * @param {object} data 包含events数组的请求体，每批仅允许1至20条。
   * @returns {Promise<object>} saved为实际成功持久化的事件数量。
   * @throws {Error} 批次数量或任一事件不符合白名单时整批拒绝。
   */
  async function client(actorId, data) {
    const events = data && data.events;
    // 限制批次体量，避免行为记录占用不成比例的数据库写入资源。
    if (!Array.isArray(events) || !events.length || events.length > 20)
      throw new Error('行为事件数量不正确');
    // 整批校验后才写，客户端不能将点击伪装成成功完成业务。
    // 只有page_view或白名单click可进入存储，不接受客户端自定义业务动作。
    if (
      events.some(
        (event) =>
          !event ||
          !VIEWS.includes(event.view) ||
          (event.kind !== 'page_view' && !(event.kind === 'click' && CLICKS.includes(event.name)))
      )
    )
      throw new Error('行为事件不正确');
    let saved = 0;
    // 通过校验后逐条尽力写入，单条日志存储失败不改变已提交的家庭业务。
    for (const event of events) {
      if (
        await record({
          // 使用鉴权身份覆盖客户端来源，只能声称观察到交互，不能伪造业务成功。
          actorId,
          source: 'client',
          outcome: 'observed',
          kind: event.kind,
          name: event.kind === 'page_view' ? 'enter' : event.name,
          view: event.view,
        })
      )
        saved++;
    }
    // 返回成功数量供调用方观测，不回传持久化日志或家庭成员资料。
    return { saved };
  }
  return { record, client };
}
module.exports = { createActivityRecorder };
